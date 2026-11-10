/**
 * 会话正文搜索：只索引 user / assistant 的正文 content。
 *
 * - 工具调用、工具输出、system / compact-summary / local-command 不参与匹配
 * - 按文件 mtime + size 缓存正文，避免每次查询重复解析大型 session JSON
 * - 普通搜索按 Unicode 不区分大小写子串；正则通过 vm 超时隔离灾难性回溯
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAX_QUERY_LENGTH = 256;
const MAX_SNIPPET_LENGTH = 180;
const REGEX_TIMEOUT_MS = 100;
const MAX_MATCHES_PER_SESSION = 1000;

function extractMessageText(message) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return '';
  if (message.kind === 'local-command' || message.kind === 'compact-summary') return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type && part.type !== 'text' && part.type !== 'output_text') return '';
      return typeof part.text === 'string' ? part.text : '';
    }).filter(Boolean).join('\n').trim();
  }
  if (typeof content?.text === 'string') return content.text.trim();
  if (typeof message.text === 'string') return message.text.trim();
  return '';
}

function extractSessionBodyMessages(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const extracted = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = extractMessageText(message);
    if (text) extracted.push({ index, role: message.role, text });
  }
  return extracted;
}

function createSessionBodySearch(options = {}) {
  const sessionsDir = options.sessionsDir;
  const cache = new Map();
  const maxCacheEntries = Math.max(1, Number(options.maxCacheEntries) || 512);

  function getCachedBody(filePath, stat) {
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.messages;
    let session;
    try {
      session = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      cache.delete(filePath);
      return null;
    }
    const messages = extractSessionBodyMessages(session);
    cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
    if (cache.size > maxCacheEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    return messages;
  }

  function buildSnippet(text, start, end) {
    const source = String(text || '');
    const hitStart = Math.max(0, Math.min(start, source.length));
    const hitEnd = Math.max(hitStart, Math.min(end, source.length));
    const context = Math.max(0, Math.floor((MAX_SNIPPET_LENGTH - (hitEnd - hitStart)) / 2));
    const from = Math.max(0, hitStart - context);
    const to = Math.min(source.length, hitEnd + context);
    const raw = source.slice(from, to);
    const positions = new Array(raw.length + 1);
    let normalized = '';
    let inWhitespace = false;
    for (let index = 0; index < raw.length; index++) {
      const char = raw[index];
      if (/\s/.test(char)) {
        positions[index] = normalized.length;
        if (!inWhitespace && normalized) normalized += ' ';
        inWhitespace = true;
      } else {
        positions[index] = normalized.length;
        normalized += char;
        inWhitespace = false;
      }
    }
    positions[raw.length] = normalized.length;
    const leading = normalized.length - normalized.trimStart().length;
    const trailing = normalized.length - normalized.trimEnd().length;
    normalized = normalized.slice(leading, normalized.length - trailing);
    const normalizePosition = (position) => Math.max(0, Math.min(
      normalized.length,
      (positions[Math.max(0, Math.min(position, raw.length))] ?? normalized.length) - leading,
    ));
    const snippetHitStart = normalizePosition(hitStart - from);
    const snippetHitEnd = Math.max(snippetHitStart, normalizePosition(hitEnd - from));
    const prefix = from > 0 ? '…' : '';
    return {
      text: `${prefix}${normalized}${to < source.length ? '…' : ''}`,
      start: snippetHitStart + prefix.length,
      end: snippetHitEnd + prefix.length,
    };
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findAll(regex, text, limit) {
    regex.lastIndex = 0;
    let count = 0;
    let first = null;
    while (count < limit) {
      const match = regex.exec(text);
      if (!match) break;
      if (!first) first = { start: match.index, end: match.index + match[0].length };
      count++;
      if (match[0].length === 0) regex.lastIndex++;
    }
    return { count, first, capped: count === limit };
  }

  function createRegexMatcher(pattern) {
    const context = vm.createContext({});
    try {
      vm.runInContext(`const regex = new RegExp(${JSON.stringify(pattern)}, 'giu')`, context, { timeout: REGEX_TIMEOUT_MS });
    } catch (error) {
      return { error: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? '正则执行超时' : '正则无效' };
    }
    return {
      find(text, limit) {
        try {
          context.text = String(text || '');
          context.limit = limit;
          const result = vm.runInContext(
            `(() => {
              regex.lastIndex = 0;
              let count = 0;
              let first = null;
              while (count < limit) {
                const match = regex.exec(text);
                if (!match) break;
                if (!first) first = { start: match.index, end: match.index + match[0].length };
                count++;
                if (match[0].length === 0) regex.lastIndex++;
              }
              return { count, first, capped: count === limit };
            })()`,
            context,
            { timeout: REGEX_TIMEOUT_MS },
          );
          return result;
        } catch (error) {
          return { error: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? '正则执行超时' : '正则无效' };
        }
      },
    };
  }

  function search(query, useRegex = false) {
    const value = String(query || '').trim();
    if (!value) return { ok: true, error: '', results: [] };
    if (value.length > MAX_QUERY_LENGTH) return { ok: false, error: '搜索词过长', results: [] };
    let matcher;
    if (useRegex) {
      const regexMatcher = createRegexMatcher(value);
      if (regexMatcher.error) return { ok: false, error: regexMatcher.error, results: [] };
      matcher = regexMatcher;
    } else {
      const regex = new RegExp(escapeRegExp(value), 'giu');
      matcher = { find: (text, limit) => findAll(regex, text, limit) };
    }

    let files;
    try {
      files = fs.readdirSync(sessionsDir).filter((file) => file.endsWith('.json'));
    } catch {
      return { ok: true, error: '', results: [] };
    }
    const results = [];
    const present = new Set();
    for (const file of files) {
      const filePath = path.join(sessionsDir, file);
      present.add(filePath);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      const messages = getCachedBody(filePath, stat);
      if (!messages) continue;
      let matchCount = 0;
      let firstSnippet = null;
      let matchCountCapped = false;
      for (const message of messages) {
        const remaining = MAX_MATCHES_PER_SESSION - matchCount;
        if (remaining <= 0) break;
        const found = matcher.find(message.text, remaining);
        if (found?.error) return { ok: false, error: found.error, results: [] };
        if (!found?.count) continue;
        matchCount += found.count;
        if (found.capped) matchCountCapped = true;
        if (!firstSnippet && found.first) firstSnippet = buildSnippet(message.text, found.first.start, found.first.end);
        if (matchCount >= MAX_MATCHES_PER_SESSION) break;
      }
      if (matchCount > 0) {
        results.push({
          sessionId: file.slice(0, -5),
          matchCount,
          matchCountCapped,
          snippet: firstSnippet?.text || '',
          snippetStart: firstSnippet?.start || 0,
          snippetEnd: firstSnippet?.end || 0,
        });
      }
    }
    for (const key of cache.keys()) {
      if (!present.has(key)) cache.delete(key);
    }
    return { ok: true, error: '', results };
  }

  return { search, extractSessionBodyMessages, clearCache: () => cache.clear() };
}

module.exports = {
  MAX_QUERY_LENGTH,
  extractMessageText,
  extractSessionBodyMessages,
  createSessionBodySearch,
};
