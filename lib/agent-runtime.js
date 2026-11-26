const {
  mergeTurnUsage,
  normalizeTurnUsage,
  subtractTurnUsage,
  sumTurnUsage,
  turnUsageToRaw,
} = require('./turn-stats');

/**
 * Claude / Codex 运行时适配器（工厂模式，约 458 行）。
 *
 * 工厂 createAgentRuntime(deps) 注入路径/模型配置/会话读写等依赖，
 * 返回 5 个函数：buildClaudeSpawnSpec / buildCodexSpawnSpec /
 * processClaudeEvent / processCodexEvent / processRuntimeEvent。
 *
 * 双 Agent 行为不对称，所有差异在此实现：
 *   - 权限模式映射：default/plan/yolo → 各自 CLI 参数（详见 docs/ARCHITECTURE.md）
 *   - resume 语义：claude --resume vs codex exec resume
 *   - 附件注入：Claude stream-json stdin vs Codex --image
 *   - 模型 spec 拆分：Codex 支持 gpt-5.4(high) 形式，拆为 --model + -c model_reasoning_effort
 *   - ⚠ Codex plan + resume 顺序：-s read-only 必须 push 到 resume 前
 *
 * 事件归一化：原始 Claude/Codex 事件 → 统一 text_delta/tool_start/tool_end/usage/cost/system_message
 *
 * 详细差异表见 docs/ARCHITECTURE.md "Agent 适配层差异"。
 */
function createAgentRuntime(deps) {
  const {
    processEnv,
    CLAUDE_PATH,
    CODEX_PATH,
    MODEL_MAP,
    loadModelConfig,
    applyCustomTemplateToSettings,
    loadCodexConfig,
    prepareCodexCustomRuntime,
    resolveCodexGatewayEnv,
    resolveAnthropicGateway,
    codexProxyBaseUrl,
    gatewayParts,
    wsSend,
    truncateObj,
    sanitizeToolInput,
    isInjectedClaudeUserEntry,
    loadSession,
    saveSession,
    setRuntimeSessionId,
    getRuntimeSessionId,
  } = deps;

  const routeGatewayParts = typeof gatewayParts === 'function' ? gatewayParts : () => ({
    gateway: 'direct-apirouter', transport: 'direct', upstream: 'apirouter',
  });
  const resolveGateway = typeof resolveCodexGatewayEnv === 'function'
    ? resolveCodexGatewayEnv
    : () => ({ baseUrl: '', apiKey: '' });
  const resolveMessagesGateway = typeof resolveAnthropicGateway === 'function'
    ? resolveAnthropicGateway
    : () => ({ baseUrl: '', authToken: '' });
  const proxyBaseUrl = typeof codexProxyBaseUrl === 'function'
    ? codexProxyBaseUrl
    : () => 'http://127.0.0.1:8787';

  const MAX_FULL_TEXT_CHARS = 2 * 1024 * 1024; // 2M UTF-16 code units
  const MAX_TOOL_CALLS = 200;
  // 压缩续接摘要的固定开场白。stream-json 的 user 事件只输出合并后的 isSynthetic，
  // 不透传 isCompactSummary，实时通道只能按这句话认出摘要。
  const COMPACT_SUMMARY_PREFIX = /^This session is being continued from a previous conversation/;

  // 千分位格式化 token 数（93 158 → "93,158"）；非有限数返回 null
  function formatTokenCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function appendFullText(entry, text) {
    if (!text) return;
    const remaining = MAX_FULL_TEXT_CHARS - entry.fullText.length;
    if (remaining <= 0) {
      entry.fullTextTruncated = true;
      return;
    }
    if (text.length <= remaining) {
      entry.fullText += text;
    } else {
      // Avoid splitting a surrogate pair at the boundary
      let end = remaining;
      if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
        end -= 1;
      }
      entry.fullText += text.slice(0, end);
      entry.fullTextTruncated = true;
    }
  }

  function appendRuntimeTextSegment(entry, text) {
    if (!text || !text.trim()) return;
    if (!Array.isArray(entry.segments)) entry.segments = [];
    const previous = entry.segments[entry.segments.length - 1];
    if (previous?.type === 'text') previous.content += text;
    else entry.segments.push({ type: 'text', content: text });
  }

  function appendRuntimeToolSegment(entry, toolCall) {
    if (!toolCall) return;
    if (!Array.isArray(entry.segments)) entry.segments = [];
    const previous = entry.segments[entry.segments.length - 1];
    if (previous?.type === 'tools') previous.toolCalls.push(toolCall);
    else entry.segments.push({ type: 'tools', toolCalls: [toolCall] });
  }

  // Claude 2.1.311 emits one assistant event per completed content block. All
  // blocks of one model response share message.id, while their usage can be a
  // partial snapshot. Keep the largest snapshot per id, then sum distinct model
  // responses. result.usage supersedes this fallback because it is the final
  // turn aggregate.
  function captureClaudeUsage(entry, event) {
    const rawUsage = event?.message?.usage || event?.usage;
    if (!rawUsage || typeof rawUsage !== 'object') return;
    const messageId = String(event?.message?.id || event?.uuid || 'claude-response');
    if (!(entry.claudeUsageByMessageId instanceof Map)) entry.claudeUsageByMessageId = new Map();
    const previous = entry.claudeUsageByMessageId.get(messageId);
    entry.claudeUsageByMessageId.set(messageId, mergeTurnUsage(previous, rawUsage));
    if (!entry.claudeUsageFromResult) {
      entry.lastUsage = turnUsageToRaw(sumTurnUsage(entry.claudeUsageByMessageId.values()));
    }
  }

  function markClaudeResult(entry, event) {
    entry.turnEndedAtMs = Date.now();
    const duration = Number(event?.duration_api_ms ?? event?.durationApiMs);
    if (Number.isFinite(duration) && duration >= 0) entry.apiDurationMs = duration;
    if (event?.usage && typeof event.usage === 'object') {
      entry.lastUsage = event.usage;
      entry.claudeUsageFromResult = true;
    }
  }

  /**
   * 构建 Claude CLI spawn 命令参数。
   *
   * 基础参数：-p --output-format stream-json --verbose
   * 权限模式：default/plan/yolo → --permission-mode / --dangerously-skip-permissions
   * Resume：--resume <claudeSessionId>
   * 附件：有附件时加 --input-format stream-json，附件走 stdin
   * 环境清理：删除 ANTHROPIC_* / CLAUDECODE / CLAUDE_CODE
   *
   * @param {object} session
   * @param {object} options - 含 attachments / mode / cwd 等
   */
  function buildClaudeSpawnSpec(session, options = {}) {
    const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (hasAttachments) args.push('--input-format', 'stream-json');
    const permMode = session.permissionMode || 'yolo';
    switch (permMode) {
      case 'yolo':
        args.push('--dangerously-skip-permissions');
        break;
      case 'plan':
        args.push('--permission-mode', 'plan');
        break;
      case 'default':
        args.push('--permission-mode', 'default');
        break;
    }
    const modelCfg = loadModelConfig();
    let localSettings = null;
    if (modelCfg.mode !== 'custom') {
      const codexConfig = loadCodexConfig();
      const route = routeGatewayParts(session.gateway || session.codexGateway || codexConfig.gateway);
      const gatewayEnv = resolveMessagesGateway(route.upstream);
      const upstreamBase = route.transport === 'proxy'
        ? `${proxyBaseUrl()}/${route.upstream}`
        : gatewayEnv.baseUrl;
      if (!gatewayEnv.authToken) {
        return { error: `Claude ${route.upstream} 网关缺少认证 token，请检查 APIROUTER_* / LLMPROXY_* 配置。` };
      }
      if (!upstreamBase) {
        return { error: `Claude ${route.upstream} 网关缺少 base URL，请检查 APIROUTER_BASE_URL / LLMPROXY_BASE_URL。` };
      }
      if (!options.settingsPath) {
        return { error: 'Claude 运行目录缺少 per-spawn settings 文件路径。' };
      }
      const settingsEnv = {
        ANTHROPIC_BASE_URL: upstreamBase,
        ANTHROPIC_AUTH_TOKEN: gatewayEnv.authToken,
      };
      const customHeaders = [
        processEnv.ANTHROPIC_CUSTOM_HEADERS,
        processEnv.CODEX_LITELLM_END_USER_ID ? `X-LiteLLM-End-User-Id: ${processEnv.CODEX_LITELLM_END_USER_ID}` : '',
        processEnv.CODEX_CLIENT_HOSTNAME ? `X-Client-Hostname: ${processEnv.CODEX_CLIENT_HOSTNAME}` : '',
      ].filter(Boolean).join('\n');
      if (customHeaders) settingsEnv.ANTHROPIC_CUSTOM_HEADERS = customHeaders;
      localSettings = settingsEnv;
      // Never put credentials in argv: spawn args are logged and visible in ps.
      args.push('--settings', options.settingsPath);
    }
    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
    }
    if (session.model) {
      args.push('--model', session.model);
    }
    // 思考强度。未设置时不传，交由 CLI 用默认值。
    if (session.effort) {
      args.push('--effort', session.effort);
    }

    const env = { ...processEnv };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CC_WEB_PASSWORD;
    // 标记「这一轮是 cc-web 拉起来的」，供子进程里的 Claude Code hooks 判断环境。
    // 依据：cc-web 是「一条用户消息 = 一个一次性 claude -p 进程」，回合收尾进程即退出，
    // 用 run_in_background 起的命令会随之被 kill，所以 hook 只在置位时收紧后台任务用法；
    // 终端里的交互会话不带这个标记，不受影响。
    env.CC_WEB_SESSION = '1';
    // 认证与网关配置通过 --settings 明确传给 CLI。CLI 入口会重新加载
    // ~/.agents/*.env，仅设置父进程环境会被入口脚本覆盖成默认 llmproxy。
    const ANTHROPIC_ENV_KEEP = new Set([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ]);
    for (const k of Object.keys(env)) {
      if (k.startsWith('ANTHROPIC_') && !ANTHROPIC_ENV_KEEP.has(k)) delete env[k];
    }

    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find((t) => t.name === modelCfg.activeTemplate);
      if (tpl) applyCustomTemplateToSettings(tpl);
    }

    if (localSettings) {
      env.ANTHROPIC_BASE_URL = localSettings.ANTHROPIC_BASE_URL;
      env.ANTHROPIC_AUTH_TOKEN = localSettings.ANTHROPIC_AUTH_TOKEN;
      env.ANTHROPIC_CUSTOM_HEADERS = localSettings.ANTHROPIC_CUSTOM_HEADERS || '';
      delete env.ANTHROPIC_API_KEY;
    }

    return {
      command: CLAUDE_PATH,
      args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'claude',
      mode: permMode,
      resume: !!session.claudeSessionId,
      settingsEnv: localSettings,
      settingsPath: localSettings ? options.settingsPath : '',
    };
  }

  /**
   * 构建 Codex CLI spawn 命令参数。
   *
   * 基础参数：exec --json --skip-git-repo-check
   * 权限模式：default=--full-auto / plan=-s read-only / yolo=--dangerously-bypass-approvals-and-sandbox
   * Resume：exec resume <runtimeId> -
   * ⚠ plan + resume 顺序：-s read-only 必须在 resume 子命令前（CLI 限制）
   * 模型 spec 拆分：gpt-5.4(high) → --model gpt-5.4 -c model_reasoning_effort="high"
   *   支持等级：medium / high / xhigh
   * 附件：逐个追加 --image <path>
   * 环境清理：按 runtimeConfig 设 CODEX_HOME / OPENAI_API_KEY
   *
   * @param {object} session
   * @param {object} options
   */
  function buildCodexSpawnSpec(session, options = {}) {
    const codexConfig = loadCodexConfig();
    const runtimeConfig = prepareCodexCustomRuntime(codexConfig, session);
    if (runtimeConfig?.error) {
      return { error: runtimeConfig.error };
	    }
	    const runtimeId = getRuntimeSessionId(session);
	    const args = ['exec'];
	    args.push('--json', '--skip-git-repo-check');

	    // Every local-mode route uses a private provider name: the managed
	    // provider table cannot be changed reliably with -c, and using one table
	    // keeps direct/proxy switching independent from ~/.codex/config.toml.
	    const route = routeGatewayParts(session.gateway || session.codexGateway || codexConfig.gateway);
	    const gatewayEnv = resolveGateway(route.upstream);
	    // A Codex thread keeps the provider identity recorded in its session_meta.
	    // The transport selected for this turn may change, so only reuse the name;
	    // the injected provider table below always uses the current route's URL.
	    const requestedProvider = runtimeId ? String(session.codexProvider || '').trim() : '';
	    const codexProvider = /^[A-Za-z0-9_-]+$/.test(requestedProvider)
	      ? requestedProvider
	      : 'ccweb_gateway';
	    if (runtimeConfig.mode === 'local') {
	      if (!gatewayEnv.apiKey) {
	        return { error: `Codex ${route.upstream} 网关缺少 API key，请检查 APIROUTER_API_KEY / LLMPROXY_API_KEY。` };
	      }
	      if (route.transport === 'direct' && !gatewayEnv.baseUrl) {
	        return { error: `Codex ${route.upstream} 网关缺少 base URL，请检查 APIROUTER_BASE_URL / LLMPROXY_BASE_URL。` };
	      }
	      const providerBaseUrl = route.transport === 'proxy'
	        ? `${proxyBaseUrl()}/${route.upstream}/v1`
	        : gatewayEnv.baseUrl;
	      args.push(
	        '-c', `model_provider=${JSON.stringify(codexProvider)}`,
	        // Codex enables Remote Compaction v2 whenever the provider name is
	        // exactly "OpenAI". That mode appends a `compaction_trigger` input
	        // item, which the Responses→Chat Completions proxy cannot convert,
	        // so auto-compaction would fail the whole turn once the context
	        // passes `model_auto_compact_token_limit`. Declare the capability
	        // unsupported so Codex summarizes locally instead.
	        '-c', `model_providers.${codexProvider}={name="OpenAI",`
	          + `base_url=${JSON.stringify(providerBaseUrl)},wire_api="responses",`
	          + `requires_openai_auth=false,env_key="${route.upstream === 'llmproxy'
	            ? 'LLMPROXY_API_KEY' : 'APIROUTER_API_KEY'}",`
	          + 'env_http_headers={"X-LiteLLM-End-User-Id"="CODEX_LITELLM_END_USER_ID",'
	          + '"X-Client-Hostname"="CODEX_CLIENT_HOSTNAME"},'
	          + 'capabilities={remote_compaction="unsupported"}}',
	      );
	    }

	    const permMode = session.permissionMode || 'yolo';
	    // `-s/--sandbox` is an option for `codex exec`, but not for `codex exec resume`.
	    // When resuming, it must appear before the `resume` subcommand, otherwise Codex CLI errors
	    // with: "unexpected argument '-s' found".
	    if (runtimeId && permMode === 'plan') {
	      args.push('-s', 'read-only');
	    }
	    // cc-web UI supports "gpt-5.4(high)" style selection, but Codex CLI expects:
	    // - model: "gpt-5.4"
	    // - reasoning effort: config key `model_reasoning_effort = "high"`
	    const rawModel = session.model ? String(session.model).trim() : '';
	    const modelMatch = rawModel.match(/^(.*)\((low|medium|high|xhigh|max|ultra)\)\s*$/i);
	    const modelEffort = modelMatch ? String(modelMatch[2] || '').trim().toLowerCase() : '';
	    if (modelEffort) {
	      // Use TOML string literal to avoid parsing ambiguity.
	      // Like the provider `-c`s above, this must precede the `resume` subcommand:
	      // Codex 0.160.1's exec-resume branch replaces the exec-level `-c` overrides
	      // with the resume-level ones whenever `resume` carries its own `-c`, silently
	      // dropping the provider overrides and falling back to config.toml's
	      // model_provider (traffic then bypasses the localproxy adapter).
	      args.push('-c', `model_reasoning_effort="${modelEffort}"`);
	    }
	    if (runtimeId) args.push('resume');
	    switch (permMode) {
	      case 'yolo':
	        args.push('--dangerously-bypass-approvals-and-sandbox');
	        break;
	      case 'plan':
	        if (!runtimeId) args.push('-s', 'read-only');
	        break;
	      case 'default':
	      default:
	        args.push('--full-auto');
        break;
    }

    const effectiveModel = session.model;
    if (effectiveModel) {
      if (modelMatch) {
        const base = String(modelMatch[1] || '').trim();
        if (base) args.push('--model', base);
      } else {
        args.push('--model', rawModel);
      }
    }
    if (Array.isArray(options.attachments)) {
      for (const attachment of options.attachments) {
        if (attachment?.path) args.push('--image', attachment.path);
      }
    }
    if (runtimeId) {
      args.push(runtimeId, '-');
    } else {
      if (session.cwd) args.push('-C', session.cwd);
      args.push('-');
    }

    const env = { ...processEnv };
    delete env.CC_WEB_PASSWORD;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    // 同 claude 侧：给子进程留一个「这一轮来自 cc-web」的标记，供 hooks 判断。
    env.CC_WEB_SESSION = '1';
    if (runtimeConfig?.homeDir) {
      env.CODEX_HOME = runtimeConfig.homeDir;
    }
    if (runtimeConfig?.mode === 'custom') {
      env.OPENAI_API_KEY = runtimeConfig.apiKey;
      delete env.OPENAI_BASE_URL;
    } else if (runtimeConfig?.mode === 'local') {
      delete env.OPENAI_BASE_URL;
    }
    env.CODEX_LITELLM_END_USER_ID = String(
      env.CODEX_LITELLM_END_USER_ID || processEnv.LOGNAME || processEnv.USER || '',
    );
    env.CODEX_CLIENT_HOSTNAME = String(
      env.CODEX_CLIENT_HOSTNAME || (processEnv.HOSTNAME || '').split('.')[0] || '',
    );

    return {
      command: CODEX_PATH,
      args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'codex',
      mode: permMode,
      resume: !!runtimeId,
      codexRuntimeKey: runtimeConfig?.runtimeKey || '',
      codexHomeDir: runtimeConfig?.homeDir || '',
      codexProvider: runtimeConfig.mode === 'custom' ? 'openai_compat' : codexProvider,
    };
  }

  function codexToolName(item) {
    switch (item?.type) {
      case 'command_execution':
        return 'CommandExecution';
      case 'mcp_tool_call':
        return 'McpToolCall';
      case 'file_change':
        return 'FileChange';
      case 'reasoning':
        return 'Reasoning';
      default:
        return item?.type || 'CodexItem';
    }
  }

  function codexToolInput(item) {
    if (!item) return null;
    if (item.type === 'command_execution') return { command: item.command || '' };
    return truncateObj(item, 500);
  }

  function codexToolMeta(item) {
    if (!item) return null;
    switch (item.type) {
      case 'command_execution':
        return {
          kind: 'command_execution',
          title: 'Shell Command',
          subtitle: item.command || '',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          status: item.status || null,
        };
      case 'mcp_tool_call':
        return {
          kind: 'mcp_tool_call',
          title: 'MCP Tool',
          subtitle: item.tool_name || item.name || item.server_name || '',
          status: item.status || null,
        };
      case 'file_change':
        return {
          kind: 'file_change',
          title: 'File Change',
          subtitle: item.path || item.file_path || '',
          status: item.status || null,
        };
      case 'reasoning':
        return {
          kind: 'reasoning',
          title: 'Reasoning',
          subtitle: typeof item.text === 'string' ? item.text.slice(0, 120) : '',
          status: item.status || null,
        };
      default:
        return {
          kind: item.type || 'codex_item',
          title: codexToolName(item),
          subtitle: '',
          status: item.status || null,
        };
    }
  }

  function codexToolResult(item) {
    if (!item) return '';
    if (typeof item.aggregated_output === 'string' && item.aggregated_output) return item.aggregated_output;
    if (typeof item.text === 'string' && item.text) return item.text;
    return JSON.stringify(truncateObj(item, 1200));
  }

  function ensureCodexToolCall(entry, item) {
    let tc = entry.toolCalls.find((t) => t.id === item.id);
    if (tc) {
      tc.name = codexToolName(item);
      tc.kind = item.type || tc.kind || null;
      tc.meta = codexToolMeta(item) || tc.meta || null;
      if (tc.input == null) tc.input = codexToolInput(item);
      return tc;
    }
    tc = {
      name: codexToolName(item),
      id: item.id,
      kind: item.type || null,
      meta: codexToolMeta(item),
      input: codexToolInput(item),
      done: false,
    };
    appendRuntimeToolSegment(entry, tc);
    if (entry.toolCalls.length < MAX_TOOL_CALLS) entry.toolCalls.push(tc);
    else entry.toolCallsTruncated = true;
    wsSend(entry.ws, {
      type: 'tool_start',
      name: tc.name,
      toolUseId: item.id,
      input: tc.input,
      kind: tc.kind,
      meta: tc.meta,
    });
    return tc;
  }

  // tool_result 回传 → tool_end。cli 2.1.x 实测把 tool_result 放在 type:'user' 事件里，
  // 更早的版本混在 assistant 的 content 里，两处共用这段。
  function emitClaudeToolEnd(entry, block) {
    const resultText = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((c) => c.text || '').join('\n')
        : (JSON.stringify(block.content) ?? '');
    const tc = entry.toolCalls.find((t) => t.id === block.tool_use_id);
    if (tc) {
      tc.done = true;
      tc.result = resultText.slice(0, 2000);
    }
    wsSend(entry.ws, { type: 'tool_end', toolUseId: block.tool_use_id, result: resultText.slice(0, 2000) });
  }

  // user 事件的 content 既可能是裸字符串（压缩摘要、hook 注入）也可能是 text block 数组，
  // 形态随 CLI 版本变，两种都要取得出文本。
  function claudeUserEventText(event) {
    const raw = event.message?.content;
    if (typeof raw === 'string') return raw.trim();
    if (!Array.isArray(raw)) return '';
    return raw
      .filter((b) => b?.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  /**
   * 归一化 Claude stream-json 事件为 cc-web 统一事件。
   *
   * 映射：
   *   assistant.text → text_delta + appendFullText
   *   assistant.tool_use → tool_start
   *   user.tool_result → tool_end
   *   result → 累加 cost
   *   user 且 isSynthetic → system_message（按内容分流 compact_summary / goal_feedback / hook_feedback）
   *
   * 工具调用上限 MAX_TOOL_CALLS = 200。
   * appendFullText 做 2M UTF-16 code units 截断并避免切代理对。
   *
   * @param {object} entry - activeProcesses Map 中的运行时条目
   * @param {object} event - 原始 Claude 事件
   * @param {string} sessionId
   */
  function processClaudeEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'system': {
        if (event.session_id) {
          if (entry.recoveryReplay) {
            entry.recoveredRuntimeSessionId = entry.recoveredRuntimeSessionId || event.session_id;
          } else {
            const session = loadSession(sessionId);
            if (session && (!entry.claudeFreshContext || !session.claudeSessionId)) {
              session.claudeSessionId = event.session_id;
              saveSession(session);
            }
          }
        }
        // compact 事件透传（P1）。Claude CLI stream-json stdout 实测形态（cli 2.1.145）：
        //   { type:'system', subtype:'compact_boundary',
        //     compact_metadata:{ trigger:'manual'|'auto', pre_tokens:N, post_tokens:M, duration_ms:D },
        //     uuid, session_id }
        // 落盘 transcript jsonl 则是 camelCase compactMetadata.{preTokens,postTokens}——两种都防御式兼容。
        if (event.subtype === 'compact_boundary') {
          const meta = event.compact_metadata || event.compactMetadata || null;
          const preStr = formatTokenCount(meta?.pre_tokens ?? meta?.preTokens);
          const postStr = formatTokenCount(meta?.post_tokens ?? meta?.postTokens);
          const message = preStr && postStr
            ? `◎ 上下文已压缩（前 ${preStr} → 后 ${postStr} tokens）`
            : '◎ 上下文已压缩';
          wsSend(entry.ws, { type: 'system_message', kind: 'compact', message });
        }
        break;
      }

      case 'assistant': {
        captureClaudeUsage(entry, event);
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            appendRuntimeTextSegment(entry, block.text);
            appendFullText(entry, block.text);
            wsSend(entry.ws, { type: 'text_delta', text: block.text }, true);
          } else if (block.type === 'tool_use') {
            const toolInput = sanitizeToolInput(block.name, block.input);
            const tc = { name: block.name, id: block.id, input: toolInput, done: false };
            appendRuntimeToolSegment(entry, tc);
            if (entry.toolCalls.length < MAX_TOOL_CALLS) entry.toolCalls.push(tc);
            else entry.toolCallsTruncated = true;
            wsSend(entry.ws, { type: 'tool_start', name: block.name, toolUseId: block.id, input: tc.input });
          } else if (block.type === 'tool_result') {
            // 旧版 CLI 会把 tool_result 混在 assistant content 里，保留兼容。
            emitClaudeToolEnd(entry, block);
          }
        }

        if (event.session_id && !entry.recoveryReplay) {
          const session = loadSession(sessionId);
          if (session && !session.claudeSessionId) {
            session.claudeSessionId = event.session_id;
            saveSession(session);
          }
        }
        break;
      }

      case 'result': {
        markClaudeResult(entry, event);
        if (entry.recoveryReplay) {
          if (event.session_id) entry.recoveredRuntimeSessionId = entry.recoveredRuntimeSessionId || event.session_id;
          entry.lastCost = event.total_cost_usd || null;
          break;
        }
        const session = loadSession(sessionId);
        if (session) {
          // “新上下文”轮次只接受第一个新 ID；后续事件反复携带旧 ID 时不能把已失效
          // 的 resume 句柄重新写回。真实 CLI 的 system 事件先于 result，mock 也保持该顺序。
          if (event.session_id && (!entry.claudeFreshContext || !session.claudeSessionId)) {
            session.claudeSessionId = event.session_id;
          }
          if (event.total_cost_usd) session.totalCost = (session.totalCost || 0) + event.total_cost_usd;
          saveSession(session);
        }
        entry.lastCost = event.total_cost_usd || null;
        if (entry.ws && event.total_cost_usd !== undefined) {
          wsSend(entry.ws, { type: 'cost', costUsd: session?.totalCost || 0 }, true);
        }
        break;
      }

      case 'user': {
        // 工具结果。cli 2.1.x 实测 tool_result 只出现在 type:'user' 事件里（该事件另带
        // tool_use_result 字段），assistant 事件里从不出现——漏接这里工具卡片会一直停在
        // running 的闪烁小点，且历史消息的 tc.result 永远是空的。
        const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
        const toolResults = blocks.filter((b) => b?.type === 'tool_result' && b.tool_use_id);
        if (toolResults.length > 0) {
          for (const block of toolResults) emitClaudeToolEnd(entry, block);
          break;
        }

        // CLI-injected synthetic messages (e.g. /goal evaluator's Stop hook feedback).
        // Real user messages enter via stdin and are not echoed back as stream-json user events.
        // ⚠ isSynthetic 是 isMeta || isVisibleInTranscriptOnly || isCompactSummary 的并集，
        // stdout 不透传具体来源，只能按内容再分流：压缩续接摘要要走折叠卡片，
        // caveat / local-command 这类注入条目根本不该出现在对话里。
        if (!event.isSynthetic) break;
        const text = claudeUserEventText(event);
        if (!text) break;
        if (COMPACT_SUMMARY_PREFIX.test(text)) {
          wsSend(entry.ws, { type: 'system_message', kind: 'compact_summary', message: text });
          break;
        }
        if (isInjectedClaudeUserEntry(event, text)) break;
        wsSend(entry.ws, {
          type: 'system_message',
          kind: /^Stop hook feedback:/.test(text) ? 'goal_feedback' : 'hook_feedback',
          message: text,
        });
        break;
      }
    }
  }

  /**
   * 归一化 Codex JSON 事件为 cc-web 统一事件。
   *
   * 映射：
   *   item.started（非 agent_message）→ ensureCodexToolCall → tool_start
   *   item.completed agent_message → text_delta
   *   item.completed 其他 → tool_end
   *   item.* compaction / context_compaction → system_message（压缩提示，不当工具调用渲染）
   *   turn.completed → usage
   *   turn.failed / error → entry.lastError
   *   "Reconnecting..." → system_message
   *
   * Codex item 类型 → 工具名映射在 codexToolName：
   *   command_execution / mcp_tool_call / file_change / reasoning
   *
   * @param {object} entry
   * @param {object} event
   * @param {string} sessionId
   */
  function processCodexEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'thread.started': {
        if (!event.thread_id) break;
        if (entry.recoveryReplay) {
          entry.recoveredRuntimeSessionId = entry.recoveredRuntimeSessionId || event.thread_id;
          break;
        }
        const session = loadSession(sessionId);
        if (session) {
          setRuntimeSessionId(session, event.thread_id);
          if (entry.codexHomeDir) session.codexHomeDir = entry.codexHomeDir;
          if (entry.codexRuntimeKey) session.codexRuntimeKey = entry.codexRuntimeKey;
          if (entry.codexProvider) session.codexProvider = entry.codexProvider;
          saveSession(session);
        }
        break;
      }

      case 'turn.started': {
        entry.turnStartedAtMs = Date.now();
        break;
      }

      case 'item.started': {
        const item = event.item;
        if (!item || !item.id || item.type === 'agent_message') break;
        // Codex 压缩产物（codex cli 0.146 为 compaction / context_compaction 类型 item，
        // 不带 pre/post token 数）：不当工具调用渲染，item.completed 时统一提示（P1）
        if (item.type === 'compaction' || item.type === 'context_compaction') break;
        if (item.type !== 'reasoning') entry.codexLastOutputWasText = false;
        ensureCodexToolCall(entry, item);
        break;
      }

      case 'item.completed': {
        const item = event.item;
        if (!item || !item.id) break;
        if (item.type === 'compaction' || item.type === 'context_compaction') {
          wsSend(entry.ws, { type: 'system_message', kind: 'compact', message: '◎ 上下文已压缩' });
          break;
        }
        if (item.type === 'agent_message') {
          if (item.text) {
            appendRuntimeTextSegment(entry, item.text);
            appendFullText(entry, item.text);
            wsSend(entry.ws, { type: 'text_delta', text: item.text }, true);
            entry.codexLastOutputWasText = true;
          }
          break;
        }
        if (item.type !== 'reasoning') entry.codexLastOutputWasText = false;
        const tc = ensureCodexToolCall(entry, item);
        const resultText = codexToolResult(item).slice(0, 2000);
        tc.done = true;
        tc.result = resultText;
        wsSend(entry.ws, {
          type: 'tool_end',
          toolUseId: item.id,
          result: resultText,
          kind: tc.kind,
          meta: tc.meta,
        });
        break;
      }

      case 'turn.completed': {
        if (!entry.turnStartedAtMs) entry.turnStartedAtMs = Date.now();
        entry.turnEndedAtMs = Date.now();
        const turnDuration = Number(event.duration_ms ?? event.durationMs);
        if (Number.isFinite(turnDuration) && turnDuration >= 0) entry.turnDurationMs = turnDuration;
        const cumulativeUsage = event.usage || null;
        const usage = cumulativeUsage
          ? (entry.codexThreadUsageBaseline
            ? subtractTurnUsage(cumulativeUsage, entry.codexThreadUsageBaseline)
            : normalizeTurnUsage(cumulativeUsage))
          : null;
        if (cumulativeUsage) {
          entry.codexThreadUsageBaseline = normalizeTurnUsage(cumulativeUsage);
          entry.codexCumulativeUsage = cumulativeUsage;
        }
        entry.lastUsage = usage ? turnUsageToRaw(usage) : null;
        entry.usageSource = usage ? 'codex_thread_delta' : null;
        if (entry.recoveryReplay) break;
        const session = loadSession(sessionId);
        if (session && usage) {
          session.totalUsage = {
            inputTokens: cumulativeUsage.input_tokens || 0,
            cachedInputTokens: cumulativeUsage.cached_input_tokens || 0,
            outputTokens: cumulativeUsage.output_tokens || 0,
          };
          saveSession(session);
          wsSend(entry.ws, { type: 'usage', totalUsage: session.totalUsage }, true);
        }
        break;
      }

      case 'turn.failed': {
        const message = event.error?.message || 'Codex 任务失败';
        entry.lastError = message;
        break;
      }

      case 'error':
        if (event.message) {
          if (/^Reconnecting\.\.\./.test(event.message)) {
            wsSend(entry.ws, { type: 'system_message', message: event.message });
          } else {
            entry.lastError = event.message;
          }
        }
        break;
    }
  }

  /**
   * 按 entry.agent 分派到 processClaudeEvent 或 processCodexEvent。
   *
   * @param {object} entry
   * @param {object} event
   * @param {string} sessionId
   */
  function processRuntimeEvent(entry, event, sessionId) {
    if (entry.agent === 'codex') processCodexEvent(entry, event, sessionId);
    else processClaudeEvent(entry, event, sessionId);
  }

  return {
    buildClaudeSpawnSpec,
    buildCodexSpawnSpec,
    processClaudeEvent,
    processCodexEvent,
    processRuntimeEvent,
  };
}

module.exports = { createAgentRuntime };
