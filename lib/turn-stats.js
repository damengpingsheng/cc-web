'use strict';

const USAGE_FIELDS = [
  ['inputTokens', ['input_tokens', 'inputTokens']],
  ['cachedInputTokens', ['cached_input_tokens', 'cache_read_input_tokens', 'cachedInputTokens', 'cacheReadInputTokens']],
  ['cacheCreationInputTokens', ['cache_creation_input_tokens', 'cacheCreationInputTokens']],
  ['outputTokens', ['output_tokens', 'outputTokens']],
];

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readUsageField(raw, keys) {
  if (!raw || typeof raw !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = nonNegativeNumber(raw[key]);
    if (value !== null) return value;
  }
  return null;
}

function hasTurnUsage(raw) {
  return USAGE_FIELDS.some(([, keys]) => readUsageField(raw, keys) !== null);
}

function hasCachedUsageData(agent, raw) {
  const keys = agent === 'claude'
    ? ['cache_read_input_tokens', 'cacheReadInputTokens', 'cache_creation_input_tokens', 'cacheCreationInputTokens']
    : ['cached_input_tokens', 'cachedInputTokens'];
  return keys.some((key) => (
    raw
    && typeof raw === 'object'
    && Object.prototype.hasOwnProperty.call(raw, key)
    && nonNegativeNumber(raw[key]) !== null
  ));
}

function normalizeTurnUsage(raw) {
  const usage = {};
  for (const [field, keys] of USAGE_FIELDS) {
    usage[field] = readUsageField(raw, keys) || 0;
  }
  return usage;
}

function mergeTurnUsage(left, right) {
  const a = normalizeTurnUsage(left);
  const b = normalizeTurnUsage(right);
  const merged = {};
  for (const [field] of USAGE_FIELDS) merged[field] = Math.max(a[field], b[field]);
  return merged;
}

function sumTurnUsage(usages) {
  const total = normalizeTurnUsage(null);
  for (const usage of usages) {
    const normalized = normalizeTurnUsage(usage);
    for (const [field] of USAGE_FIELDS) total[field] += normalized[field];
  }
  return total;
}

function turnUsageToRaw(usage) {
  const normalized = normalizeTurnUsage(usage);
  return {
    input_tokens: normalized.inputTokens,
    cached_input_tokens: normalized.cachedInputTokens,
    cache_creation_input_tokens: normalized.cacheCreationInputTokens,
    output_tokens: normalized.outputTokens,
  };
}

function subtractTurnUsage(cumulative, baseline) {
  const current = normalizeTurnUsage(cumulative);
  const previous = normalizeTurnUsage(baseline);
  const delta = {};
  for (const [field] of USAGE_FIELDS) {
    delta[field] = Math.max(0, current[field] - previous[field]);
  }
  return delta;
}

function calculateCacheHitRate(agent, usage) {
  const normalized = normalizeTurnUsage(usage);
  if (!hasCachedUsageData(agent, usage)) return null;
  const denominator = agent === 'claude'
    ? normalized.inputTokens + normalized.cachedInputTokens + normalized.cacheCreationInputTokens
    : normalized.inputTokens;
  if (!(denominator > 0)) return null;
  return Math.max(0, Math.min(1, normalized.cachedInputTokens / denominator));
}

function calculateOutputTokensPerSecond(outputTokens, durationMs) {
  const tokens = nonNegativeNumber(outputTokens);
  const duration = nonNegativeNumber(durationMs);
  if (tokens === null || !(duration > 0)) return null;
  return tokens / (duration / 1000);
}

function createTurnStats({
  agent,
  usage,
  durationMs,
  durationSource,
  durationIncludesToolWait,
  usageSource,
  completedAt,
} = {}) {
  if ((agent !== 'claude' && agent !== 'codex') || !hasTurnUsage(usage)) return null;
  const normalizedUsage = normalizeTurnUsage(usage);
  const duration = nonNegativeNumber(durationMs);
  return {
    agent,
    completedAt: completedAt || new Date().toISOString(),
    usage: normalizedUsage,
    cacheHitRate: calculateCacheHitRate(agent, usage),
    outputTokensPerSecond: calculateOutputTokensPerSecond(normalizedUsage.outputTokens, duration),
    durationMs: duration,
    durationSource: durationSource || 'process_wall_time',
    durationIncludesToolWait: durationIncludesToolWait !== false,
    usageSource: usageSource || null,
  };
}

module.exports = {
  calculateCacheHitRate,
  calculateOutputTokensPerSecond,
  createTurnStats,
  hasCachedUsageData,
  hasTurnUsage,
  mergeTurnUsage,
  normalizeTurnUsage,
  subtractTurnUsage,
  sumTurnUsage,
  turnUsageToRaw,
};
