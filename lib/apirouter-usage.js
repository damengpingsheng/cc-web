/**
 * APIRouter 模型 key 可读用量。
 *
 * 仅使用模型 API key 可访问的接口：/api/usage/token/ 和 /api/log/token。
 * 订阅余额取当前 key 最新一条带订阅计费信息的日志，不把最近 1000 条日志
 * 汇总成今日或本月用量。
 */

function normalizeConfig(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    authToken: String(raw.authToken || '').trim(),
    timezone: String(raw.timezone || 'Asia/Shanghai').trim(),
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildQuotaDisplay(statusData) {
  const quotaPerUnit = finiteNumber(statusData?.quota_per_unit);
  if (!quotaPerUnit || quotaPerUnit <= 0) {
    throw new Error('APIRouter quota_per_unit is unavailable');
  }
  const type = String(statusData?.quota_display_type || 'USD').trim().toUpperCase();
  const usdExchangeRate = finiteNumber(statusData?.usd_exchange_rate) || 1;
  const customExchangeRate = finiteNumber(statusData?.custom_currency_exchange_rate) || 1;
  const customSymbol = String(statusData?.custom_currency_symbol || '').trim() || '¤';
  if (type === 'CNY') return { type, quotaPerUnit, exchangeRate: usdExchangeRate, symbol: '¥' };
  if (type === 'TOKENS') return { type, quotaPerUnit, exchangeRate: 1, symbol: '' };
  if (type === 'CUSTOM') return { type, quotaPerUnit, exchangeRate: customExchangeRate, symbol: customSymbol };
  return { type: 'USD', quotaPerUnit, exchangeRate: 1, symbol: '$' };
}

function quotaToDisplay(value, display) {
  const quota = finiteNumber(value);
  if (quota === null) return null;
  if (display.type === 'TOKENS') return quota;
  return (quota / display.quotaPerUnit) * display.exchangeRate;
}

function parseLogOther(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function subscriptionFromLog(row, display) {
  const other = parseLogOther(row?.other);
  if (!other) return null;
  const total = quotaToDisplay(other.subscription_total, display);
  let used = quotaToDisplay(other.subscription_used, display);
  const remaining = quotaToDisplay(other.subscription_remain, display);
  if (total === null && used === null && remaining === null) return null;
  if (used === null && total !== null && remaining !== null) used = Math.max(0, total - remaining);
  const usedPercent = total !== null && total > 0 && used !== null
    ? (used / total) * 100
    : null;
  const createdAt = finiteNumber(row?.created_at);
  return {
    title: String(other.subscription_plan_title || '').trim(),
    total,
    used,
    remaining,
    usedPercent,
    billingSource: String(other.billing_source || '').trim(),
    observedAt: createdAt === null ? null : new Date(createdAt * 1000).toISOString(),
  };
}

function latestSubscription(logs, display) {
  const rows = (Array.isArray(logs) ? logs : [])
    .filter((row) => row && typeof row === 'object')
    .slice()
    .sort((left, right) => (finiteNumber(right.created_at) || 0) - (finiteNumber(left.created_at) || 0));
  for (const row of rows) {
    const subscription = subscriptionFromLog(row, display);
    if (subscription) return subscription;
  }
  return null;
}

function buildApirouterUsagePayload(config, now, statusBody, tokenBody, logBody) {
  const statusData = statusBody?.data;
  if (!statusData || typeof statusData !== 'object') throw new Error('APIRouter status response is invalid');
  const tokenData = tokenBody?.data;
  if (!tokenData || typeof tokenData !== 'object' || tokenData.object !== 'token_usage') {
    throw new Error('APIRouter token usage response is invalid');
  }
  const display = buildQuotaDisplay(statusData);
  const unlimitedQuota = tokenData.unlimited_quota === true;
  const expiresAt = finiteNumber(tokenData.expires_at);
  const userQuota = tokenData.user_quota && typeof tokenData.user_quota === 'object'
    ? tokenData.user_quota
    : null;
  const walletAvailable = quotaToDisplay(userQuota?.total_available, display);
  const walletUsed = quotaToDisplay(userQuota?.total_used, display);

  return {
    type: 'apirouter_usage',
    ok: true,
    key: {
      name: String(tokenData.name || '').trim(),
      unlimitedQuota,
      available: unlimitedQuota ? null : quotaToDisplay(tokenData.total_available, display),
      granted: quotaToDisplay(tokenData.total_granted, display),
      used: quotaToDisplay(tokenData.total_used, display),
      expiresAt: expiresAt && expiresAt > 0
        ? new Date(expiresAt > 1e12 ? expiresAt : expiresAt * 1000).toISOString()
        : null,
    },
    wallet: walletAvailable === null && walletUsed === null
      ? null
      : { available: walletAvailable, used: walletUsed },
    subscription: latestSubscription(logBody?.data, display),
    currency: display.type,
    currencySymbol: display.symbol,
    timezone: config.timezone,
    updatedAt: now.toISOString(),
  };
}

function createApirouterUsageCollector({
  fetchImpl = globalThis.fetch,
  cacheTtlMs = 3 * 60 * 1000,
  failureCacheTtlMs = 60 * 1000,
  nowProvider = () => new Date(),
} = {}) {
  let cache = null;
  let cachedAt = 0;
  let failure = null;
  let failedAt = 0;
  let pending = null;

  async function fetchJson(config, path, signal, withAuth) {
    const headers = { Accept: 'application/json' };
    if (withAuth) headers.Authorization = `Bearer ${config.authToken}`;
    const res = await fetchImpl(`${config.baseUrl}${path}`, { headers, signal });
    if (!res.ok) throw new Error(`APIRouter ${path} HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`APIRouter ${path} returned invalid JSON`);
    }
    if (body?.success === false || body?.code === false) {
      throw new Error(`APIRouter ${path}: ${body.message || 'request failed'}`);
    }
    return body;
  }

  async function refresh(rawConfig, { timeoutMs = 120000, force = false } = {}) {
    const config = normalizeConfig(rawConfig);
    if (!config.enabled) {
      return { status: 'disabled', message: 'APIRouter 用量统计已关闭' };
    }
    if (!config.baseUrl) throw new Error('APIROUTER_BASE_URL is not configured');
    if (!config.authToken) throw new Error('APIROUTER_API_KEY is not configured');
    if (!force && cache && Date.now() - cachedAt < cacheTtlMs) return cache;
    if (!force && failure && Date.now() - failedAt < failureCacheTtlMs) throw failure;
    if (pending) return pending;
    pending = (async () => {
      const now = nowProvider();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const logsPromise = fetchJson(config, '/api/log/token', controller.signal, true)
          .catch(() => ({ data: [] }));
        const [statusBody, tokenBody, logBody] = await Promise.all([
          fetchJson(config, '/api/status', controller.signal, false),
          fetchJson(config, '/api/usage/token/', controller.signal, true),
          logsPromise,
        ]);
        const payload = buildApirouterUsagePayload(config, now, statusBody, tokenBody, logBody);
        cache = payload;
        cachedAt = Date.now();
        failure = null;
        failedAt = 0;
        return payload;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        failedAt = Date.now();
        throw failure;
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
  normalizeConfig,
  buildQuotaDisplay,
  quotaToDisplay,
  parseLogOther,
  subscriptionFromLog,
  latestSubscription,
  buildApirouterUsagePayload,
  createApirouterUsageCollector,
};
