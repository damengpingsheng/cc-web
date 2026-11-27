/**
 * Claude 会话上下文水位估算与预防性压缩判定（P2 预防性水位压缩 + 运行中双指标估算核心）。
 *
 * 设计约束（最高优先级）：
 *   - 纯函数、零副作用：只读 jsonl，不写任何状态，便于 regression 直接单测
 *   - 任何读取/解析失败一律返回 null / false（调用方静默走原流程，正常路径零改变）
 *
 * inspectClaudeTranscriptContext(jsonlPath)：
 *   从 Claude 原生 transcript jsonl 末尾向前扫到最近一条主链 compact_boundary 即停，
 *   返回 API 上报 usageTokens、postCompactTokens、未压缩段字节数 segmentBytes、
 *   保守估算 token（ceil(segmentBytes / 3.0)）与 effectiveTokens（取较大值）。
 *
 * estimateClaudeContextUsage(jsonlPath)：
 *   保留原签名，委托给 inspectClaudeTranscriptContext(jsonlPath)?.effectiveTokens ?? null。
 *
 * shouldPreemptiveCompact(usageTokens, modelLabel, pctThreshold)：
 *   按模型标签推断 1M / 200k 窗口，返回 usageTokens >= window * pct / 100。
 *
 * Codex 不走这条路径：它由自身的 model_auto_compact_token_limit 在真实用户消息
 * 那一轮压缩，cc-web 注入 /compact 只会多一轮无意义的模型调用。
 *
 * stream-json compact 事件形态（Claude CLI 2.1.145 实测，见 lib/agent-runtime.js P1 注释）：
 *   stdout stream-json 为 snake_case compact_metadata.{pre_tokens,post_tokens}；
 *   落盘 transcript jsonl 为 camelCase compactMetadata.{preTokens,postTokens}。
 */

const fs = require('fs');

const BYTES_PER_TOKEN_CONSERVATIVE = 3.0;

// Binary base64 length is not a text-token count. Keep a modest placeholder;
// actual image/document token costs depend on the model and cannot be inferred here.
function estimateMessageBytes(message) {
  const json = JSON.stringify(message, function (key, value) {
    if (key === 'data' && this?.type === 'base64' && typeof value === 'string') return '';
    return value;
  });
  return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
}

/** 仅允许主链非错误、非 <synthetic> 的 assistant 条目参与 usage 判定 */
function isValidMainChainAssistantUsage(entry) {
  if (!entry || entry.type !== 'assistant') return false;
  if (entry.isSidechain === true) return false;
  if (entry.isApiErrorMessage === true) return false;
  if (entry.message?.model === '<synthetic>') return false;
  return true;
}

/** 从 jsonl 行解析出的 usage 三项之和；行不合法或全 0 占位返回 null */
function sumUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens);
  if (!Number.isFinite(input) || input < 0) return null;
  let total = input;
  for (const key of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total > 0 ? total : null;
}

/**
 * 扫描 Claude 原生 transcript，返回未压缩段的水位快照。
 *
 * @param {string} jsonlPath - Claude 原生 transcript jsonl 路径
 * @returns {{
 *   usageTokens: number|null,
 *   postCompactTokens: number|null,
 *   segmentBytes: number,
 *   estimatedSegmentTokens: number,
 *   effectiveTokens: number|null,
 *   lastCompactLineOffset: number,
 * } | null}
 */
function inspectClaudeTranscriptContext(jsonlPath) {
  if (!jsonlPath || typeof jsonlPath !== 'string') return null;
  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  let usageTokens = null;
  let postCompactTokens = null;
  let segmentBytes = 0;
  let lastCompactLineOffset = 0;
  let lastCompactUuid = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.isSidechain !== true) {
      if (usageTokens === null) {
        const meta = entry.compactMetadata || entry.compact_metadata || null;
        const post = Number(meta?.postTokens ?? meta?.post_tokens);
        if (Number.isFinite(post) && post > 0) postCompactTokens = post;
      }
      lastCompactUuid = entry.uuid || null;
      const prefix = lines.slice(0, i + 1).join('\n');
      lastCompactLineOffset = Buffer.byteLength(prefix, 'utf8') + (i < lines.length - 1 ? 1 : 0);
      break;
    }

    if (entry.isSidechain === true) continue;

    if ((entry.type === 'user' || entry.type === 'assistant') && entry.message !== undefined) {
      segmentBytes += estimateMessageBytes(entry.message);
    }

    if (usageTokens === null && isValidMainChainAssistantUsage(entry)) {
      const total = sumUsageTokens(entry.message?.usage);
      if (total !== null) usageTokens = total;
    }
  }

  const estimatedSegmentTokens = segmentBytes > 0
    ? Math.ceil(segmentBytes / BYTES_PER_TOKEN_CONSERVATIVE)
    : 0;
  const baseTokens = usageTokens ?? postCompactTokens;
  const effectiveTokens = (baseTokens !== null || segmentBytes > 0)
    ? Math.max(baseTokens ?? 0, estimatedSegmentTokens)
    : null;

  return {
    usageTokens,
    postCompactTokens,
    segmentBytes,
    estimatedSegmentTokens,
    effectiveTokens,
    lastCompactLineOffset,
    lastCompactUuid,
  };
}

/**
 * 估算某 Claude 会话下一次请求的上下文规模（tokens）。
 *
 * @param {string} jsonlPath - Claude 原生 transcript jsonl 路径
 * @returns {number|null} - 无法确凿读到水位时返回 null（调用方跳过预防压缩）
 */
function estimateClaudeContextUsage(jsonlPath) {
  return inspectClaudeTranscriptContext(jsonlPath)?.effectiveTokens ?? null;
}

/**
 * 判断当前水位是否达到预防性压缩阈值。
 *
 * @param {number} usageTokens - estimateClaudeContextUsage 的返回值
 * @param {string} modelLabel - 模型标签，含 "[1m]" 视为 1M 窗口（如 claude-opus-4-6[1m]）
 * @param {number} pctThreshold - 阈值百分比（10-99，由调用方收敛）
 * @returns {boolean}
 */
function canSyncClaudeSnapshot(boundary, snapshot) {
  if (!snapshot) return false;
  if (!boundary) return true;
  if (boundary.uuid) return snapshot.lastCompactUuid === boundary.uuid;
  return boundary.afterOffset !== null && boundary.afterOffset !== undefined
    && snapshot.lastCompactLineOffset > boundary.afterOffset;
}

function isOneMillionContext(modelLabel, disable1m) {
  const disabled = String(disable1m || '').toLowerCase();
  return disabled !== '1' && disabled !== 'true' && /1m/i.test(String(modelLabel || ''));
}

function shouldPreemptiveCompact(usageTokens, modelLabel, pctThreshold, disable1m) {
  const tokens = Number(usageTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return false;
  const windowTokens = isOneMillionContext(modelLabel, disable1m) ? 1_000_000 : 200_000;
  const pct = Number(pctThreshold);
  const pctValue = Number.isFinite(pct) ? pct : 80;
  return tokens >= (windowTokens * pctValue) / 100;
}

module.exports = {
  BYTES_PER_TOKEN_CONSERVATIVE,
  canSyncClaudeSnapshot,
  estimateClaudeContextUsage,
  estimateMessageBytes,
  inspectClaudeTranscriptContext,
  isOneMillionContext,
  isValidMainChainAssistantUsage,
  shouldPreemptiveCompact,
  sumUsageTokens,
};
