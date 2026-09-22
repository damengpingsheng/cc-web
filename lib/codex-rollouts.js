const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Codex rollout JSONL 历史解析（工厂模式，约 205 行）。
 *
 * 工厂 createCodexRolloutStore(deps) 注入 codexSessionsDir / sessionsDir /
 * normalizeSession / sanitizeToolInput 依赖，返回 4 个函数：
 *   parseCodexRolloutLines / getCodexRolloutFiles /
 *   getImportedCodexThreadIds / parseCodexRolloutFile
 *
 * 输入：~/.codex/sessions/ 下的 rollout JSONL
 * 输出：cc-web session/message 结构
 *   - message: { role, content, toolCalls?, timestamp }
 *   - meta: { threadId, cwd, title, updatedAt, cliVersion, source }
 *   - totalUsage: { inputTokens, cachedInputTokens, outputTokens }
 *
 * Tool call 解析：response_item type=function_call 建立 toolCalls 入 pendingToolCalls map；
 *   function_call_output 按 call_id 匹配并标 done + result（截断 2000 字符）。
 * Token usage：event_msg payload type=token_count，优先取 info.total_token_usage。
 *
 * 错误边界：目录不存在返回 []，单行 JSON.parse 异常跳过，单文件异常返回 null。
 */
function createCodexRolloutStore(deps) {
  const { codexSessionsDir, sessionsDir, normalizeSession, sanitizeToolInput } = deps;

  function extractCodexMessageText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .filter((item) => item && (item.type === 'input_text' || item.type === 'output_text'))
      .map((item) => item.text || '')
      .join('');
  }

  // item_completed 里的 item.content 用的是 { type: 'text' }，与 response_item 的
  // input_text/output_text 不同，这里一并接住。
  function extractCodexItemText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((item) => item && (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text'))
      .map((item) => item.text || '')
      .join('');
  }

  // source 旧版是 "cli" 这样的字符串；subagent 派生的子线程是
  // { subagent: { thread_spawn: {...} } } 这种对象，取顶层键当可读标签，
  // 否则前端直接拼字符串会渲染成 [object Object]。
  function normalizeCodexSource(source) {
    if (!source) return '';
    if (typeof source === 'string') return source;
    if (typeof source === 'object') return Object.keys(source)[0] || 'unknown';
    return String(source);
  }

  function appendAssistantContent(turn, text) {
    if (!turn || !text || !text.trim()) return;
    turn.content = turn.content ? `${turn.content}\n\n${text}` : text;
  }

  function extractCodexToolOutput(output) {
    if (typeof output === 'string') return output;
    if (Array.isArray(output)) {
      return output.map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string') return item.text;
        if (item && Array.isArray(item.content)) return extractCodexToolOutput(item.content);
        return JSON.stringify(item ?? '');
      }).join('\n');
    }
    if (output && typeof output.text === 'string') return output.text;
    return JSON.stringify(output ?? '');
  }

  function codexImportedToolMeta(payload, kind) {
    const name = payload?.name || (kind === 'custom_tool_call' ? 'CustomToolCall' : 'FunctionCall');
    return {
      kind,
      title: name,
      subtitle: name,
      status: payload?.status || null,
    };
  }

  function appendImportedToolCall(assistant, pendingToolCalls, payload, kind) {
    const toolUseId = payload?.call_id || payload?.id || crypto.randomUUID();
    const name = payload?.name || (kind === 'custom_tool_call' ? 'CustomToolCall' : 'FunctionCall');
    const rawInput = payload?.input !== undefined ? payload.input : (payload?.arguments || '');
    const tc = {
      name,
      id: toolUseId,
      kind,
      meta: codexImportedToolMeta(payload, kind),
      input: sanitizeToolInput(name, rawInput),
      done: false,
    };
    assistant.toolCalls.push(tc);
    pendingToolCalls.set(toolUseId, tc);
  }

  function completeImportedToolCall(assistant, pendingToolCalls, payload, kind) {
    const toolUseId = payload?.call_id || payload?.id || crypto.randomUUID();
    let tc = pendingToolCalls.get(toolUseId);
    if (!tc) {
      tc = {
        name: kind === 'custom_tool_call' ? 'CustomToolCall' : 'FunctionCall',
        id: toolUseId,
        kind,
        meta: codexImportedToolMeta(payload, kind),
        input: null,
        done: false,
      };
      assistant.toolCalls.push(tc);
      pendingToolCalls.set(toolUseId, tc);
    }
    tc.kind = tc.kind || kind;
    tc.meta = tc.meta || codexImportedToolMeta(payload, kind);
    tc.done = true;
    tc.result = extractCodexToolOutput(payload?.output).slice(0, 2000);
  }

  /**
   * 核心：rollout JSONL 行数组 → { meta, messages, totalUsage }。
   *
   * @param {string[]} lines - JSONL 文件按行分割
   * @returns {{ meta: object, messages: Array, totalUsage: object }}
   */
  function parseCodexRolloutLines(lines) {
    const messages = [];
    const pendingToolCalls = new Map();
    const meta = { threadId: null, cwd: null, title: '', updatedAt: null, cliVersion: null, source: null };
    const totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let currentAssistant = null;
    let sawRealUserMessage = false;
    let sawSessionMeta = false;
    const fallbackUserMessages = [];

    function ensureAssistant(ts) {
      if (!currentAssistant) {
        currentAssistant = { role: 'assistant', content: '', toolCalls: [], timestamp: ts || null };
      } else if (!currentAssistant.timestamp && ts) {
        currentAssistant.timestamp = ts;
      }
      return currentAssistant;
    }

    function flushAssistant() {
      if (!currentAssistant) return;
      if ((currentAssistant.content || '').trim() || currentAssistant.toolCalls.length > 0) {
        messages.push(currentAssistant);
      }
      currentAssistant = null;
      pendingToolCalls.clear();
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const ts = entry.timestamp || null;
      if (ts) meta.updatedAt = ts;

      if (entry.type === 'session_meta') {
        // subagent 子线程的 rollout 会写两条 session_meta：第一条是子线程自己
        // (source 为 {subagent:{...}})，第二条是父线程的 (source='cli')。无条件覆盖
        // 会让子线程文件冒充成父会话——threadId 变成父 id、source 变成 'cli'，
        // 既躲过 subagent 过滤，又在列表里按文件名倒序抢在真父文件前面占坑，
        // 导入后拿到的是早已结束的子线程历史。父会话被 resume 多次也只有一条
        // session_meta，所以只认第一条是安全的。
        if (sawSessionMeta) continue;
        sawSessionMeta = true;
        meta.threadId = entry.payload?.id || meta.threadId;
        meta.cwd = entry.payload?.cwd || meta.cwd;
        meta.cliVersion = entry.payload?.cli_version || meta.cliVersion;
        meta.source = normalizeCodexSource(entry.payload?.source) || meta.source;
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const total = entry.payload?.info?.total_token_usage || null;
        const usage = entry.payload?.info?.last_token_usage || null;
        if (total) {
          totalUsage.inputTokens = Math.max(totalUsage.inputTokens, total.input_tokens || 0);
          totalUsage.cachedInputTokens = Math.max(totalUsage.cachedInputTokens, total.cached_input_tokens || 0);
          totalUsage.outputTokens = Math.max(totalUsage.outputTokens, total.output_tokens || 0);
        } else if (usage) {
          totalUsage.inputTokens += usage.input_tokens || 0;
          totalUsage.cachedInputTokens += usage.cached_input_tokens || 0;
          totalUsage.outputTokens += usage.output_tokens || 0;
        }
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const text = String(entry.payload?.message || '').trim();
        if (text) {
          sawRealUserMessage = true;
          flushAssistant();
          if (!meta.title) meta.title = text.slice(0, 80).replace(/\n/g, ' ');
          messages.push({ role: 'user', content: text, timestamp: ts });
        }
        continue;
      }

      // CLI 0.153.4 起不再写 event_msg/user_message，真实用户输入改放进
      // item_completed 的 item（type 为 PascalCase 的 UserMessage），紧跟在对应的
      // response_item 之后，所以按此处顺序入列即可。response_item 里那条 role=user
      // 是 AGENTS.md 环境注入，只能进 fallback，命中这里后 fallback 会整体作废。
      if (entry.type === 'event_msg' && entry.payload?.type === 'item_completed'
          && entry.payload?.item?.type === 'UserMessage') {
        const text = extractCodexItemText(entry.payload.item.content).trim();
        if (text) {
          sawRealUserMessage = true;
          flushAssistant();
          if (!meta.title) meta.title = text.slice(0, 80).replace(/\n/g, ' ');
          messages.push({ role: 'user', content: text, timestamp: ts });
        }
        continue;
      }

      if (entry.type !== 'response_item') continue;

      const payload = entry.payload || {};
      switch (payload.type) {
      case 'message': {
        if (payload.role === 'assistant') {
          const text = extractCodexMessageText(payload.content);
          if (text.trim()) {
            if (currentAssistant && ((currentAssistant.content || '').trim() || currentAssistant.toolCalls.length > 0)) {
              flushAssistant();
            }
            appendAssistantContent(ensureAssistant(ts), text);
          }
        } else if (payload.role === 'user' && !sawRealUserMessage) {
          const text = extractCodexMessageText(payload.content);
          if (text.trim()) {
            fallbackUserMessages.push({ role: 'user', content: text, timestamp: ts });
          }
        }
        break;
      }
      case 'agent_message': {
        // subagent 回给父线程的消息，原来落到 default 被整条丢掉。
        // 在父会话里按助手内容呈现，标注来源方便分辨是哪个 subagent 说的。
        const text = extractCodexMessageText(payload.content);
        if (text.trim()) {
          const author = String(payload.author || '').trim();
          appendAssistantContent(ensureAssistant(ts), author ? `[${author}]\n${text}` : text);
        }
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        appendImportedToolCall(
          ensureAssistant(ts),
          pendingToolCalls,
          payload,
          payload.type,
        );
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        completeImportedToolCall(
          ensureAssistant(ts),
          pendingToolCalls,
          payload,
          payload.type === 'custom_tool_call_output' ? 'custom_tool_call' : 'function_call',
        );
        break;
      }
      default:
        break;
      }
    }

    flushAssistant();
    if (!sawRealUserMessage && fallbackUserMessages.length > 0) {
      const fallback = fallbackUserMessages[0];
      if (!meta.title) meta.title = fallback.content.trim().slice(0, 80).replace(/\n/g, ' ');
      return { meta, messages: fallbackUserMessages.concat(messages), totalUsage };
    }
    return { meta, messages, totalUsage };
  }

  function walkFiles(dir, files = []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(fullPath, files);
      else if (entry.isFile()) files.push(fullPath);
    }
    return files;
  }

  /**
   * 递归收集 codexSessionsDir 下所有 .jsonl 文件，按修改时间逆序。
   * 目录不存在时返回 []。
   */
  function getCodexRolloutFiles() {
    if (!fs.existsSync(codexSessionsDir)) return [];
    return walkFiles(codexSessionsDir, []).filter((filePath) => filePath.endsWith('.jsonl')).sort().reverse();
  }

  /**
   * 扫描已导入 session 的 codexThreadId，返回去重集合（避免重复导入）。
   */
  function getImportedCodexThreadIds() {
    const imported = new Set();
    try {
      for (const f of fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json'))) {
        try {
          const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')));
          if (session.codexThreadId) imported.add(session.codexThreadId);
        } catch {}
      }
    } catch {}
    return imported;
  }

  let threadNameCache = { map: null, mtimeMs: 0 };

  // 终端 codex /resume 列表显示的名字来自 ~/.codex/session_index.jsonl 的 thread_name
  // (codex 生成的摘要或 /rename 结果)，rollout 文件里没有这个信息。
  // 同一个 id 会追加多行，保留 updated_at 最新的那条；索引在跑会话时会变，按 mtime 失效缓存。
  function getCodexThreadNames() {
    const indexPath = path.join(path.dirname(codexSessionsDir), 'session_index.jsonl');
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(indexPath).mtimeMs; } catch { return new Map(); }
    if (threadNameCache.map && threadNameCache.mtimeMs === mtimeMs) return threadNameCache.map;
    const map = new Map();
    try {
      for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const name = String(entry?.thread_name || '').trim();
        if (!entry?.id || !name) continue;
        const prev = map.get(entry.id);
        if (prev && String(prev.updatedAt) > String(entry.updated_at || '')) continue;
        map.set(entry.id, { name, updatedAt: entry.updated_at || '' });
      }
    } catch {
      return new Map();
    }
    threadNameCache = { map, mtimeMs };
    return map;
  }

  /**
   * 读取单文件并调用 parseCodexRolloutLines，附 filePath。
   * 异常返回 null（不抛错）。
   */
  function parseCodexRolloutFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = parseCodexRolloutLines(content.split('\n'));
      parsed.filePath = filePath;
      // 标题优先用终端 codex 的 thread_name，与 /resume 列表口径一致；
      // 索引里没登记的会话(本机 91 个可见会话里约一半)回落到解析出的首句
      const named = parsed.meta.threadId ? getCodexThreadNames().get(parsed.meta.threadId) : null;
      if (named?.name) parsed.meta.title = named.name;
      return parsed;
    } catch {
      return null;
    }
  }

  // 只取首条 session_meta 的归属信息，不解析消息体。删除会话时要逐个甄别上百个
  // rollout(单个可达 8MB+)，整读一遍代价太大。首条 session_meta 总在文件开头，
  // 但首行可能有 20KB+，所以按行扫描而不是读固定长度的缓冲区。
  function readCodexRolloutOwner(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (entry.type !== 'session_meta') continue;
      const source = entry.payload?.source;
      const parentThreadId = (source && typeof source === 'object')
        ? (source.subagent?.thread_spawn?.parent_thread_id || null)
        : null;
      return {
        threadId: entry.payload?.id || null,
        source: normalizeCodexSource(source),
        parentThreadId,
      };
    }
    return null;
  }

  return {
    parseCodexRolloutLines,
    getCodexRolloutFiles,
    getImportedCodexThreadIds,
    parseCodexRolloutFile,
    readCodexRolloutOwner,
  };
}

module.exports = { createCodexRolloutStore };
