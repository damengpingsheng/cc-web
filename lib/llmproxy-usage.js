/**
 * llmproxy 个人用量汇总与缓存。
 *
 * llmproxy 使用共享 key 时，账号维度的 /user/daily/activity 会把多个人的请求
 * 算在同一个 key 所属用户下。个人用量应从 spend log 的 end_user 字段聚合。
 * 本模块只查询配置中固定的个人标识，避免把共享 key 下其他用户的数据带进来。
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_VERSION = 1;
// Spend logs may arrive after a request completes. Re-read a bounded overlap and
// de-duplicate by request id so delayed rows are included without recounting.
const INCREMENTAL_OVERLAP_MS = 6 * 60 * 60 * 1000;

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
  const metrics = {
    spend: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, models: [],
  };
  Object.defineProperty(metrics, '_modelMap', { value: new Map(), enumerable: false });
  return metrics;
}

function cloneMetrics(source) {
  const metrics = emptyMetrics();
  if (!source) return metrics;
  metrics.spend = Number(source.spend) || 0;
  metrics.totalTokens = Number(source.totalTokens) || 0;
  metrics.promptTokens = Number(source.promptTokens) || 0;
  metrics.completionTokens = Number(source.completionTokens) || 0;
  metrics.cacheReadTokens = Number(source.cacheReadTokens) || 0;
  for (const sourceModel of Array.isArray(source.models) ? source.models : []) {
    const model = {
      model: String(sourceModel?.model || 'unknown-model'),
      calls: Number(sourceModel?.calls) || 0,
      spend: Number(sourceModel?.spend) || 0,
      totalTokens: Number(sourceModel?.totalTokens) || 0,
      promptTokens: Number(sourceModel?.promptTokens) || 0,
      completionTokens: Number(sourceModel?.completionTokens) || 0,
      cacheReadTokens: Number(sourceModel?.cacheReadTokens) || 0,
    };
    metrics.models.push(model);
    metrics._modelMap.set(model.model, model);
  }
  return metrics;
}

function usageIdentity(config) {
  return {
    baseUrl: config.baseUrl,
    endUser: config.endUser,
    timezone: config.timezone,
    historyStart: config.historyStart,
  };
}

function sameUsageIdentity(left, right) {
  return left?.baseUrl === right?.baseUrl
    && left?.endUser === right?.endUser
    && left?.timezone === right?.timezone
    && left?.historyStart === right?.historyStart;
}

function rowIdentity(row) {
  if (row?.request_id) return `request:${row.request_id}`;
  return `row:${JSON.stringify([
    row?.startTime,
    row?.endTime,
    row?.model,
    row?.spend,
    row?.total_tokens,
    row?.prompt_tokens,
    row?.completion_tokens,
  ])}`;
}

function buildSnapshotCachedPayload(snapshot) {
  if (!snapshot?.payload) return null;
  return {
    ...snapshot.payload,
    type: 'llmproxy_usage',
    ok: true,
    stale: true,
    warning: '显示上次成功数据',
    today: cloneMetrics(snapshot.payload.today),
    monthToDate: cloneMetrics(snapshot.payload.monthToDate),
    history: cloneMetrics(snapshot.payload.history),
  };
}

function cacheReadTokensFromRow(row) {
  const usage = row?.metadata?.usage_object;
  if (!usage || typeof usage !== 'object') return 0;
  const candidates = [
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.cache_read_input_tokens,
    usage.cached_tokens,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function addLogToMetrics(metrics, row) {
  metrics.spend += Number(row?.spend) || 0;
  metrics.promptTokens += Number(row?.prompt_tokens) || 0;
  metrics.completionTokens += Number(row?.completion_tokens) || 0;
  metrics.totalTokens += Number(row?.total_tokens) || 0;
  const cacheReadTokens = cacheReadTokensFromRow(row);
  metrics.cacheReadTokens += cacheReadTokens;

  const modelName = String(row?.model || row?.model_group || '').trim() || 'unknown-model';
  let model = metrics._modelMap.get(modelName);
  if (!model) {
    model = {
      model: modelName, calls: 0, spend: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0,
    };
    metrics._modelMap.set(modelName, model);
    metrics.models.push(model);
  }
  model.calls += 1;
  model.spend += Number(row?.spend) || 0;
  model.promptTokens += Number(row?.prompt_tokens) || 0;
  model.completionTokens += Number(row?.completion_tokens) || 0;
  model.totalTokens += Number(row?.total_tokens) || 0;
  model.cacheReadTokens += cacheReadTokens;
}

function sortModelMetrics(metrics) {
  metrics.models.sort((a, b) => (b.spend - a.spend)
    || (b.totalTokens - a.totalTokens)
    || (a.model || '').localeCompare(b.model || ''));
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
  initialTimeoutMs = 10 * 60 * 1000,
  snapshotPath = '',
  nowProvider = () => new Date(),
} = {}) {
  let cache = null;
  let cachedAt = 0;
  let cacheIdentity = null;
  let refreshedInMemory = false;
  let snapshot = null;
  let pending = null;

  function readSnapshot() {
    if (!snapshotPath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      if (parsed?.version !== SNAPSHOT_VERSION || !parsed?.payload
          || !Number.isFinite(Date.parse(parsed.lastSyncedAt))) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function writeSnapshot(nextSnapshot) {
    if (!snapshotPath) return;
    const directory = path.dirname(snapshotPath);
    const tempPath = `${snapshotPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(tempPath, `${JSON.stringify(nextSnapshot, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tempPath, snapshotPath);
    } catch {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
    }
  }

  snapshot = readSnapshot();
  cache = buildSnapshotCachedPayload(snapshot);
  cachedAt = Date.parse(snapshot?.payload?.updatedAt || '') || 0;
  cacheIdentity = snapshot?.identity || null;

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
    if (!config.baseUrl) throw new Error('LLMPROXY_BASE_URL is not configured');
    if (!config.authToken) throw new Error('LLMPROXY_API_KEY is not configured');
    if (!config.endUser) {
      throw new Error('llmproxy usage configuration incomplete: endUser is required');
    }
    if (!force && cache && Date.now() - cachedAt < cacheTtlMs) return cache;
    if (pending) return pending;
    pending = (async () => {
      const now = nowProvider();
      const ranges = buildUsageRanges(now, config.timezone, config.historyStart);
      const identity = usageIdentity(config);
      const usableSnapshot = snapshot && sameUsageIdentity(snapshot.identity, identity) ? snapshot : null;
      const historyStartMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(config.historyStart);
      if (!historyStartMatch) throw new Error(`Invalid llmproxy historyStart: ${config.historyStart}`);
      const [historyYear, historyMonth, historyDay] = historyStartMatch.slice(1).map(Number);
      const historyStartMs = localDateTimeToUtc(
        { year: historyYear, month: historyMonth, day: historyDay },
        config.timezone,
      ).getTime();
      const incrementalStartMs = usableSnapshot
        ? Math.max(historyStartMs, Date.parse(usableSnapshot.lastSyncedAt) - INCREMENTAL_OVERLAP_MS)
        : historyStartMs;
      const fetchRange = usableSnapshot
        ? {
            start: formatUtcBoundary(partsInTimeZone(new Date(incrementalStartMs), 'UTC')),
            end: ranges.history.end,
          }
        : ranges.history;
      const controller = new AbortController();
      const effectiveTimeoutMs = usableSnapshot ? timeoutMs : Math.max(timeoutMs, initialTimeoutMs);
      const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      try {
        const rows = await fetchLogs(config, fetchRange, controller.signal);
        const localNow = partsInTimeZone(now, config.timezone);
        const todayKey = `${localNow.year}-${localNow.month}-${localNow.day}`;
        const monthKey = `${localNow.year}-${localNow.month}`;
        const today = usableSnapshot?.todayKey === todayKey
          ? cloneMetrics(usableSnapshot.payload.today)
          : emptyMetrics();
        const monthToDate = usableSnapshot?.monthKey === monthKey
          ? cloneMetrics(usableSnapshot.payload.monthToDate)
          : emptyMetrics();
        const history = usableSnapshot
          ? cloneMetrics(usableSnapshot.payload.history)
          : emptyMetrics();
        const todayStart = Date.parse(ranges.today.start.replace(' ', 'T') + 'Z');
        const todayEnd = Date.parse(ranges.today.end.replace(' ', 'T') + 'Z');
        const monthStart = Date.parse(ranges.month.start.replace(' ', 'T') + 'Z');
        const monthEnd = Date.parse(ranges.month.end.replace(' ', 'T') + 'Z');
        const recentCutoff = now.getTime() - INCREMENTAL_OVERLAP_MS;
        const recentRows = (Array.isArray(usableSnapshot?.recentRows) ? usableSnapshot.recentRows : [])
          .filter((item) => item && item.key && Number.isFinite(Number(item.at))
            && Number(item.at) >= incrementalStartMs);
        const processed = new Set(recentRows.map((item) => item.key));
        for (const row of rows) {
          const key = rowIdentity(row);
          if (processed.has(key)) continue;
          processed.add(key);
          addLogToMetrics(history, row);
          const timestamp = Date.parse(row?.startTime);
          if (Number.isFinite(timestamp)) {
            if (timestamp >= todayStart && timestamp < todayEnd) addLogToMetrics(today, row);
            if (timestamp >= monthStart && timestamp < monthEnd) addLogToMetrics(monthToDate, row);
            if (timestamp >= recentCutoff) recentRows.push({ key, at: timestamp });
          }
        }
        sortModelMetrics(today);
        sortModelMetrics(monthToDate);
        sortModelMetrics(history);
        const remainingUsd = config.monthlyQuotaUsd - monthToDate.spend;
        const usedPercent = config.monthlyQuotaUsd > 0
          ? (monthToDate.spend / config.monthlyQuotaUsd) * 100
          : null;
        const payload = buildUsagePayload(config, now, { today, monthToDate, history, remainingUsd, usedPercent });
        cache = payload;
        cachedAt = Date.now();
        cacheIdentity = identity;
        refreshedInMemory = true;
        const nextSnapshot = {
          version: SNAPSHOT_VERSION,
          identity,
          lastSyncedAt: now.toISOString(),
          todayKey,
          monthKey,
          recentRows,
          payload: {
            ...payload,
            today: cloneMetrics(today),
            monthToDate: cloneMetrics(monthToDate),
            history: cloneMetrics(history),
          },
        };
        snapshot = nextSnapshot;
        writeSnapshot(nextSnapshot);
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

  function getCached(rawConfig) {
    if (!rawConfig || !cacheIdentity) return cache;
    const config = normalizeConfig(rawConfig);
    if (!sameUsageIdentity(cacheIdentity, usageIdentity(config))) return null;
    const monthSpend = Number(cache?.monthToDate?.spend) || 0;
    return {
      ...cache,
      monthlyQuotaUsd: config.monthlyQuotaUsd,
      remainingUsd: config.monthlyQuotaUsd - monthSpend,
      usedPercent: config.monthlyQuotaUsd > 0 ? (monthSpend / config.monthlyQuotaUsd) * 100 : null,
    };
  }

  function isFresh() {
    return refreshedInMemory && !!cache && Date.now() - cachedAt < cacheTtlMs;
  }

  return { refresh, getCached, isFresh };
}

module.exports = {
  buildUsageRanges,
  buildUsagePayload,
  addLogToMetrics,
  cacheReadTokensFromRow,
  emptyMetrics,
  formatUtcBoundary,
  createUsageCollector,
  normalizeConfig,
};
