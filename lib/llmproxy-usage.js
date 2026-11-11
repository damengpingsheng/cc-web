/**
 * llmproxy 个人用量汇总与缓存。
 *
 * llmproxy 使用共享 key 时，账号维度的 /user/daily/activity 会把多个人的请求
 * 算在同一个 key 所属用户下。个人用量应从 spend log 的 end_user 字段聚合。
 * 本模块只查询配置中固定的个人标识，避免把共享 key 下其他用户的数据带进来。
 */

function normalizeConfig(raw = {}) {
  const monthlyQuotaUsd = Number(raw.monthlyQuotaUsd);
  return {
    enabled: raw.enabled !== false,
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    authToken: String(raw.authToken || '').trim(),
    endUser: String(raw.endUser || '').trim(),
    monthlyQuotaUsd: Number.isFinite(monthlyQuotaUsd) && monthlyQuotaUsd > 0 ? monthlyQuotaUsd : 2000,
    timezone: String(raw.timezone || 'Asia/Shanghai').trim(),
    historyStart: String(raw.historyStart || '2000-01-01').trim(),
  };
}

function partsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function formatUtcBoundary(parts) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function localDateTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetText = new Intl.DateTimeFormat('en-US', {
    timeZone, timeZoneName: 'longOffset',
  }).formatToParts(new Date(desired)).find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const offset = /^GMT([+-])(\d{2}):?(\d{2})$/.test(offsetText)
    ? (() => {
      const match = offsetText.match(/^GMT([+-])(\d{2}):?(\d{2})$/);
      const sign = match[1] === '-' ? -1 : 1;
      return sign * (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000;
    })()
    : 0;
  return new Date(desired - offset);
}

/**
 * llmproxy 的 spend log 日期参数按 UTC 解释，但月/日边界要按用户时区计算。
 * 返回日期范围使用紧凑格式，避免 URL 编码后部分网关无法解析。
 */
function buildUsageRanges(now = new Date(), timeZone = 'Asia/Shanghai', historyStartDate = '2000-01-01') {
  const local = partsInTimeZone(now, timeZone);
  const year = Number(local.year);
  const month = Number(local.month);
  const day = Number(local.day);
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const nextDayDate = new Date(Date.UTC(year, month - 1, day + 1));
  const monthStart = localDateTimeToUtc({ year, month, day: 1 }, timeZone);
  const monthEnd = localDateTimeToUtc({ ...nextMonth, day: 1 }, timeZone);
  const dayStart = localDateTimeToUtc({ year, month, day }, timeZone);
  const dayEnd = localDateTimeToUtc({
    year: nextDayDate.getUTCFullYear(),
    month: nextDayDate.getUTCMonth() + 1,
    day: nextDayDate.getUTCDate(),
  }, timeZone);
  const historyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(historyStartDate);
  if (!historyMatch) throw new Error(`Invalid llmproxy historyStart: ${historyStartDate}`);
  const [historyYear, historyMonth, historyDay] = historyMatch.slice(1).map(Number);
  const historyStart = localDateTimeToUtc({ year: historyYear, month: historyMonth, day: historyDay }, timeZone);
  return {
    timezone: timeZone,
    today: {
      start: formatUtcBoundary(partsInTimeZone(dayStart, 'UTC')),
      end: formatUtcBoundary(partsInTimeZone(dayEnd, 'UTC')),
    },
    month: {
      start: formatUtcBoundary(partsInTimeZone(monthStart, 'UTC')),
      end: formatUtcBoundary(partsInTimeZone(monthEnd, 'UTC')),
    },
    history: {
      start: formatUtcBoundary(partsInTimeZone(historyStart, 'UTC')),
      end: formatUtcBoundary({
        year: String(now.getUTCFullYear()).padStart(4, '0'),
        month: String(now.getUTCMonth() + 1).padStart(2, '0'),
        day: String(now.getUTCDate()).padStart(2, '0'),
        hour: String(now.getUTCHours()).padStart(2, '0'),
        minute: String(now.getUTCMinutes()).padStart(2, '0'),
        second: String(now.getUTCSeconds()).padStart(2, '0'),
      }),
    },
  };
}

function emptyMetrics() {
  return { spend: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 };
}

function addLogToMetrics(metrics, row) {
  metrics.spend += Number(row?.spend) || 0;
  metrics.promptTokens += Number(row?.prompt_tokens) || 0;
  metrics.completionTokens += Number(row?.completion_tokens) || 0;
  metrics.totalTokens += Number(row?.total_tokens) || 0;
  metrics.cacheReadTokens += Number(row?.metadata?.usage_object?.cache_read_input_tokens) || 0;
}

function buildUsagePayload(config, now, metrics) {
  return {
    type: 'llmproxy_usage',
    ok: true,
    endUser: config.endUser,
    timezone: config.timezone,
    monthlyQuotaUsd: config.monthlyQuotaUsd,
    updatedAt: now.toISOString(),
    ...metrics,
  };
}

function createUsageCollector({
  fetchImpl = globalThis.fetch,
  cacheTtlMs = 3 * 60 * 1000,
  nowProvider = () => new Date(),
} = {}) {
  let cache = null;
  let cachedAt = 0;
  let pending = null;

  async function fetchLogs(config, range, signal) {
    const rows = [];
    let page = 1;
    let totalPages = 1;
    do {
      const params = new URLSearchParams({
        start_date: range.start,
        end_date: range.end,
        end_user: config.endUser,
        page: String(page),
        page_size: '1000',
        sort_by: 'startTime',
        sort_order: 'asc',
      });
      const res = await fetchImpl(`${config.baseUrl}/spend/logs/v2?${params}`, {
        headers: { Authorization: `Bearer ${config.authToken}`, Accept: 'application/json' },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body?.total_is_capped === true) throw new Error('llmproxy spend log result is capped');
      if (Array.isArray(body?.data)) rows.push(...body.data);
      totalPages = Math.max(1, Number(body?.total_pages) || 1);
      page += 1;
    } while (page <= totalPages);
    return rows;
  }

  async function refresh(rawConfig, { timeoutMs = 120000, force = false } = {}) {
    const config = normalizeConfig(rawConfig);
    if (!config.enabled) {
      return { status: 'disabled', message: 'llmproxy 用量统计已关闭' };
    }
    if (!config.baseUrl || !config.authToken || !config.endUser) {
      throw new Error('llmproxy usage configuration incomplete');
    }
    if (!force && cache && Date.now() - cachedAt < cacheTtlMs) return cache;
    if (pending) return pending;
    pending = (async () => {
      const now = nowProvider();
      const ranges = buildUsageRanges(now, config.timezone, config.historyStart);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const rows = await fetchLogs(config, ranges.history, controller.signal);
        const today = emptyMetrics();
        const monthToDate = emptyMetrics();
        const history = emptyMetrics();
        const todayStart = Date.parse(ranges.today.start.replace(' ', 'T') + 'Z');
        const todayEnd = Date.parse(ranges.today.end.replace(' ', 'T') + 'Z');
        const monthStart = Date.parse(ranges.month.start.replace(' ', 'T') + 'Z');
        const monthEnd = Date.parse(ranges.month.end.replace(' ', 'T') + 'Z');
        for (const row of rows) {
          addLogToMetrics(history, row);
          const timestamp = Date.parse(row?.startTime);
          if (!Number.isFinite(timestamp)) continue;
          if (timestamp >= todayStart && timestamp < todayEnd) addLogToMetrics(today, row);
          if (timestamp >= monthStart && timestamp < monthEnd) addLogToMetrics(monthToDate, row);
        }
        const remainingUsd = config.monthlyQuotaUsd - monthToDate.spend;
        const usedPercent = config.monthlyQuotaUsd > 0
          ? (monthToDate.spend / config.monthlyQuotaUsd) * 100
          : null;
        const payload = buildUsagePayload(config, now, { today, monthToDate, history, remainingUsd, usedPercent });
        cache = payload;
        cachedAt = Date.now();
        return payload;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  function getCached() {
    return cache;
  }

  return { refresh, getCached };
}

module.exports = {
  buildUsageRanges,
  buildUsagePayload,
  addLogToMetrics,
  emptyMetrics,
  formatUtcBoundary,
  createUsageCollector,
  normalizeConfig,
};
