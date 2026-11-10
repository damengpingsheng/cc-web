# 运行时模型

> 会话持久化、detached 进程生命周期、关键运行时模式。架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)，契约见 [PROTOCOL.md](./PROTOCOL.md)，配置见 [CONFIG.md](./CONFIG.md)。

## Claude transcript 缺失恢复

Claude Code 会按 `cleanupPeriodDays` 清理 `~/.claude/projects/<project>/<sessionId>.jsonl`。cc-web 的 session JSON 可能仍保留消息和 `claudeSessionId`，但继续执行 `--resume` 会固定得到 `No conversation found with session ID`。

发送 Claude 消息前，服务端检查原生 transcript。缺失时不写入本轮用户消息、不 spawn CLI，而是发送 `claude_recovery_required` 并暂存消息 10 分钟。前端提供两种选择：

- `restore_snapshot`：读取 `<AI_SESSION_TRACE_ROOT>/claude/<projectKey>/<sessionId>/transcript.jsonl`，校验配套 `transcript.sha256` 及 transcript 内的 `sessionId`，原子复制到当前 cwd 对应的 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，再以同一 `claudeSessionId` 重试。
- `new_context`：清除失效的 `claudeSessionId`，保留 cc-web 消息历史，以新 Claude 上下文重试。

重放只在用户选择后发生，且用户消息只写入历史一次。恢复 token 与原 session 绑定，10 分钟后失效，取消选择不会发送任何内容。`AI_SESSION_TRACE_ROOT` 未设置时默认使用 `~/.ai-session-trace`；没有 hook 快照时仅提供 `new_context`。

## 会话持久化

### 文件布局

- `sessions/<sessionId>.json` — 会话对象（消息历史 + 元数据）
- `sessions/<sessionId>-run/` — 活跃运行目录
  - `pid` — 子进程 PID
  - `output.jsonl` — 流式输出，`FileTailer` tail 此文件

### normalizeSession

`server.js` 中 `normalizeSession()` 在加载时统一字段默认值。**新增字段必须在 `normalizeSession` 设默认值**，保证前向兼容。

当前在该函数设默认值的字段：`agent` / `claudeSessionId` / `codexThreadId` / `codexHomeDir` / `codexRuntimeKey` / `totalCost` / `totalUsage` / `taskMode` / `sshHostId` / `remoteCwd` / `group` / `titleSource` / `messages`。

**不在该函数设默认值**（由创建/业务路径显式赋值）：
- `permissionMode` — 由 `handleNewSession` / `handleMessage` 创建时赋值，默认 `'yolo'`
- `hasUnread` — 由消息处理路径动态置位
- `updated` — 由各业务路径写入

### 原子写（atomicWriteJson）

`server.js` 中 `atomicWriteJson(path, value, options)` 是统一落盘入口，避免大型 session JSON 在写入中途崩溃导致文件撕裂：

- 写 `tmp` 文件 → `fs.writeFileSync` 拿到字节 → `fs.renameSync` 替换目标（POSIX 原子）
- 可选 `options.mode`：`saveDevConfig` / `saveCodexConfig` / `saveNotifyConfig` 等含密钥的配置强制 `0o600`，防止同机其他用户读
- 所有 7 个 save 函数（`saveSession` / `saveBannedIPs` / `saveNotifyConfig` / `saveModelConfig` / `saveCodexConfig` / `saveDevConfig` / `saveAttachmentMeta`）以及 `lib/auth.js` 的 token/auth 写入都走原子写

**关键不变量**：任何崩溃都不会让目标文件停留在半写状态——要么是旧内容，要么是新内容，绝不撕裂。

### Session 对象关键字段

除 `id` / `title` / `messages` 之外：

| 字段 | 含义 |
|---|---|
| `agent` | `'claude'` 或 `'codex'` |
| `claudeSessionId` | Claude resume 句柄 |
| `codexThreadId` | Codex resume 线程 id |
| `codexHomeDir` | Codex 隔离 profile 目录（CODEX_HOME） |
| `codexRuntimeKey` | Codex runtime 认证 key |
| `permissionMode` | cc-web 内部值：`'default'` / `'plan'` / `'yolo'`（= `dangerously_skip_permissions`）。默认 `'yolo'`。Claude/Codex 各自 CLI 参数映射见 [ARCHITECTURE.md](./ARCHITECTURE.md#权限模式映射) |
| `model` | 当前会话使用的模型（Codex 创建时设默认，Claude 从模板解析） |
| `cwd` | 工作目录 |
| `taskMode` | `'local'` 或 `'remote'`（remote 携带 `sshHostId` + `remoteCwd`） |
| `totalCost` | 累计美元成本 |
| `totalUsage` | 累计 token 用量（`inputTokens` / `cachedInputTokens` / `outputTokens`） |
| `hasUnread` | 是否有未读消息（侧栏高亮） |
| `updated` | 最后更新时间戳（ISO） |
| `group` | 所属分组 id（`''`=未分组，`normalizeSession` 设默认值） |
| `titleSource` | 标题来源：`'prompt'` / `'auto'` / `'manual'` / `''`（旧数据）。自动整理只接管前两者 |

### 会话分组持久化

- `config/groups.json` — `{ "groups": [{ "id": "g_8位hex", "name", "created" }] }`，`saveGroups()` 走 `atomicWriteJson`；加载对损坏文件容错（回退空分组，仅丢归组信息不阻塞启动）
- 会话归属存于 `session.group` 字段（分组 id，`''`=未分组）
- **删除分组连带删除组内全部会话**：`handleGroupDelete` 先对组内每个会话调用 `deleteSessionCleanup`（与单删 `handleDeleteSession` 同一清理路径：杀运行中进程 + done 推送 + run 目录 + json/附件 + 本地 CLI 历史），再移除分组本身
- **归组不算会话活动**：`session_move` 不改 `session.updated`（避免列表时间戳跳动）
- **广播同步**：分组增删改名/归组后向所有已认证 WS 连接广播 `group_list` + `session_list`（多设备侧栏一致）；每个客户端 auth 成功后单独推一次 `group_list`

### 会话正文搜索

会话总台的“正文”开关默认关闭。开启后，服务端按需扫描 `sessions/*.json`，只提取 `role` 为 `user` 或 `assistant` 的正文文本；工具调用、工具输出、`system`、压缩摘要和本地命令不进入搜索范围。标题、项目目录、最后消息等字段仍由前端即时筛选，正文命中作为额外结果并入同一列表。

普通搜索按 Unicode 不区分大小写的子串匹配，正则搜索使用 `iu` 标志；表达式编译和逐条消息执行都在独立 `vm` 上下文中完成，单次执行超时为 100ms。每个会话最多统计 1000 处命中，超过时返回 `matchCountCapped: true`。首个命中返回约 180 字符的原文上下文，空白折叠后附带高亮起止位置。

解析结果按文件 `mtime + size` 缓存在内存中，未变化的会话不会重复解析；文件更新后自动重新读取，删除会话后清理对应缓存。缓存上限 512 个会话文件，不建立持久化全文索引。

## Detached 进程生命周期

### 三态流转

```
用户发送消息
    │
    ▼
spawn claude/codex (detached)         ← lib/agent-runtime.js 构建命令
    │
    ├─→ 写 PID 到 sessions/<id>-run/pid
    └─→ 流式输出到 sessions/<id>-run/output.jsonl
              │
              ▼
        FileTailer (server.js)         ← fs.watch + 500ms 轮询双保险
              │
              ├─→ 按字节偏移只读新内容
              ├─→ 缓冲半截 JSON 行
              └─→ 推送 text_delta / tool_start / tool_end 到前端
    │
    ▼
进程退出
    │
    ▼
handleProcessComplete                  ← server.js
    │
    ├─→ 累计 cost / usage 到 session
    ├─→ 检测 context limit → 自动 compact 重试
    ├─→ 驱动 /goal 多轮自治
    └─→ 触发 background_done 通知
```

### recoverProcesses（启动时恢复）

服务重启时 `recoverProcesses()` 扫描所有残留的 `*-run/` 目录：

- 子进程仍存活 → 重新 attach（继续 tail）
- 子进程已退出 → 把输出 finalize 进 session JSON

**关键含义**：服务重启**不会**终止进行中的 Claude/Codex 工作。

死亡进程回放使用 `recoveryReplay` 模式：只收集最终文本、工具调用、usage/cost 和 runtime ID，不逐事件读写 session JSON；全部读完后再原子落盘一次并清理 run 目录。Claude 的每个 `system` 事件都会带 session ID，逐事件落盘会在数千个事件的长会话上造成启动阶段大量同步 I/O。

### 中断进程（killProcess）

用户点停止按钮 / 发 abort 时，`killProcess(pid)` 杀**整个进程组**而不是单进程：

- spawn 时 detached child 自动成为 pgid leader（同 pid）
- Linux 用 `process.kill(-pid, signal)`，负数 pid 表示进程组
- **关键含义**：claude/codex 子进程如果再 spawn 了孙子进程（如 bash 执行工具调用），中断时这些孙子进程会随组一起死，不会变孤儿继续烧 token

### 修改时必须验证

变更进程 spawn / 输出解析 / run 目录结构时，必须同时检查：

- `server.js`（FileTailer / recoverProcesses / handleProcessComplete）
- `lib/agent-runtime.js`（spawn 命令构建）

并跑 `npm run regression`。

## 关键运行时模式

### 连续工具段折叠

Claude 原生历史把每个 text / tool_use 分成独立 assistant 条目，Codex rollout 也按事件记录文本与工具。服务端按用户轮次聚合 assistant 容器，同时保留容器内有序的 `segments`：相邻 text 合并为文本段，相邻工具合并为工具段，任一文本或非 assistant 消息都会结束当前工具段。前端按段渲染；同一工具段达到 2 个调用时独立折叠，单个工具平铺。不同文本段之间的工具不会合并，也不会统一搬到正文前；实时流式、收尾和刷新后的顺序一致。

旧 Codex 快照没有 `segments`，且当时的流式正文可能只是原生 rollout 的截断或摘录。刷新加载时按用户输入逐轮匹配两边历史：只有助手可见文本在首尾存在稳定锚点时，才用 rollout 的同一轮助手消息替换旧布局；无法匹配、cc-web 独有或原生 rollout 尚未完成的轮次原样保留。该迁移允许原生历史比快照短，但不会把较短的无关 rollout 当成整段快照覆盖。

### Codex 空最终回答恢复

Codex 正常退出时若本轮已执行非 reasoning 工具、最后一个输出仍是工具完成事件而非 `agent_message`，且没有其他错误或重试链，cc-web 会以 `resume` 在同一 thread 上自动追问一次最终总结。该内部追问不进入会话历史；第二次仍为空时发送明确错误，不再循环。用户中止、`/compact`、隐藏的内部轮次和上下文超限路径都不触发该恢复。

### 自动 compact 重试

会话中检测到 context limit 错误（`isContextLimitError`）时，服务端自动：

1. 注入 `/compact` 命令
2. 重放原 prompt

状态机：

- `pendingCompactRetries: Map<sessionId, ...>` — 跟踪重试状态
- `pendingSlashCommands: Map<sessionId, ...>` — 排队的 slash 命令
- `reason: 'auto'`（自动触发）vs `'normal'`（用户主动）

核心位置：`server.js` 中 `handleProcessComplete` 函数（按函数名定位最稳）。

#### 超限错误识别（双正则）

`isContextLimitError(agent, raw)` 对 stderr / fullText / completion error 做联合匹配，双 Agent 各一套短语级正则（禁止裸词宽匹配，避免把模型正文里的普通词误判为超限）：

- **Claude 分支**：`Request too large (max 20MB)`（请求体大小限制）+ token 超限短语族——`prompt is too long`（真实 CLI 报错形态：`API Error: Prompt is too long: N tokens > M maximum`）、`context window/length`、`exceed(s|ed) the maximum/context/token`、`token limit`、`too many (input) tokens`、`maximum (context) length`。
  历史缺陷：旧版只匹配 `Request too large (max 20MB)`，那不是 token 超限，导致 Claude 侧自动 compact 兜底长期失效（超限必报错、只能手动 `/compact`）。
- **Codex 分支**：`context window/length`、`token limit`、`please use /compact`、`reduce the input/prompt/message` 等（自始完整）。

#### compact 事件透传（stream-json）

CLI 执行压缩时 cc-web 把 compact 边界事件转成 `system_message`（`kind: 'compact'`）推给前端（`lib/agent-runtime.js`）：

- **Claude**：stream-json stdout 事件形态（CLI 2.1.145 实测）为 `{ type:'system', subtype:'compact_boundary', compact_metadata:{ trigger:'manual'|'auto', pre_tokens, post_tokens, duration_ms }, session_id }`（注意 stdout 为 snake_case；落盘 transcript jsonl 为 camelCase `compactMetadata.preTokens/postTokens`，两种都兼容）。文案：`◎ 上下文已压缩（前 93,158 → 后 5,762 tokens）`，token 数取不到时退化为 `◎ 上下文已压缩`。
- **Codex**：压缩产物是 `compaction` / `context_compaction` 类型的 item（`item.started` / `item.completed`，不带 pre/post token 数），completed 时发 `◎ 上下文已压缩`，且不当工具调用渲染。

#### 预防性水位压缩（P2，事前预防）

与事后兜底（上面 P0）叠加成双保险，互不依赖。仅 Claude resume 场景（`session.claudeSessionId` 存在）生效：

1. `handleMessage` 在构造 spawn 之前，用 `locateClaudeSessionJsonl`（复用原生导入的定位方式）找 `~/.claude/projects/<dir>/<sessionId>.jsonl`
2. `lib/context-usage.js` 的 `estimateClaudeContextUsage` 从文件**末尾向前**找最后一条带 usage 的 assistant 记录，取 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`（≈ 下一次请求的上下文规模）
3. `shouldPreemptiveCompact(usage, model, CC_WEB_AUTOCOMPACT_PCT)`：窗口 = 模型标签含 `[1m]` → 1,000,000，否则 200,000；水位 ≥ 窗口 × 阈值%（默认 80%）即触发
4. 触发时发 `◎ 检测到上下文接近上限，先执行压缩再发送您的消息`，然后**复用 P0 注入链路**：写 `pendingCompactRetries`（`reason:'auto'`，text=原消息）+ `pendingSlashCommands`（`kind:'compact'`）+ 以 `/compact` 为输入走 `handleMessage` spawn；compact 完成后原消息由现有 `handleProcessComplete` 重放链路发送

**零改变约束**：定位不到 jsonl / 无 usage / 解析异常 / 带附件（无法重放）/ 文本为空——一律静默走原流程。防循环护栏 `preemptCompactGuard`：预防压缩后直到观察到一次正常（非 slash 注入）运行完成、或用户手动 `/compact`、或删除会话之前，不再对同一会话重复预防压缩。

### `/goal` 多轮自治

`/goal` 是绕过 slash 分发器的特殊路径：

- 在 `handleMessage`（`server.js`）独立处理
- Claude 原样执行原生命令；Codex `exec` 会被改写为目标创建/清除提示，使同一 Web UI 可用
- 双重正则排除 `/^\/goal(?:\s|$)/i`（一处 WS switch 前、一处 `handleMessage` 内）防止走 `handleSlashCommand` switch
- 把"继续追问条件"塞入 `pendingCompactRetries`，靠 `handleProcessComplete` 循环驱动下一轮
- 前端 per-session LRU（cap 100）+ 三态分类 + optimistic flag 抗竞态

### `/loop` 定期执行

- session 的 `loop` 字段保存 `intervalMs`、`prompt` 和 `nextRunAt`；`normalizeSession()` 校验其范围
- `activeLoops` 仅保存内存定时器，启动时 `restoreSessionLoops()` 按 session 中的计划恢复
- 到点时若该会话有 agent 运行，发送状态消息并跳过；否则以隐藏的用户历史消息触发同一条 `handleMessage()` 链路

### 懒加载历史

会话历史**不**一次性发送。规则：

- 首条 `INITIAL_HISTORY_COUNT = 12` 条消息立即发送
- 旧消息按 `HISTORY_CHUNK_SIZE = 24` 分块，通过 `session_history_chunk` WebSocket 消息增量推送

常量位置：`server.js` 中 `INITIAL_HISTORY_COUNT` 与 `HISTORY_CHUNK_SIZE`（按符号名定位）。

### FileTailer

`server.js` 中的 `FileTailer` 类（按类名定位最稳），tail `output.jsonl` 实现流式推送：

- `fs.watch()` + 500ms 备份轮询双保险
- 按字节偏移只读新内容
- 缓冲半截 JSON 行直到 newline

### 进程日志 plog

`logs/process.log`，JSONL 格式，2MB 自动轮转。事件类型：

- `process_spawn` / `process_complete`
- `ws_connect` / `ws_disconnect`
- `recovery_alive` / `recovery_dead`
- `heartbeat`（活跃进程每 60s）

实现位置：`server.js` 顶部 `plog` 工厂。

### WebSocket 重连与改密踢下线

WS 连接掉线（网络抖动 / 临时断开）时前端自动重连，体验关键：**重连不打断用户当前的阅读**。

- 前端用 `hasInitialAuthCompleted` 区分「首次鉴权成功」和「重连后鉴权成功」
- 首次成功 → 加载会话列表 + 当前会话历史（`pendingInitialSessionLoad = true`）
- 重连成功 → **不**触发会话/历史重载，保留当前滚动位置、保留正在浏览的旧消息
- 服务端鉴权内存命中（digest 比对 + 24h 滑动续期），重连基本无感

**改密踢下线**：用户在 A 标签页改密后，B 标签页必须立即失效，否则旧密码登录态会留下后门。实现严格顺序：

1. `revokeAllTokens` 原子封装（先空 `tokens.json` → 再写新 hash → 再签新 token）
2. 遍历 `wss.clients`，对**其他**已认证 WS（`_ccwebAuthed === true`）：先置 `_ccwebAuthed = false`（防 close race 中再发消息），再 `close()`
3. 旧 WS 收到 close 后重连，但 token 已失效，被踢回登录页

**关键不变量**：改密完成的瞬间，没有任何旧 token 能继续操作 WS，也没有任何旧 WS 连接能继续 send。

### WS 心跳与断线内容补齐

**心跳**（服务端 `wss` 连接入口 + 启动区定时器，按 `WS_PING_INTERVAL_MS` 定位）：每 `CC_WEB_WS_PING_INTERVAL_MS`（默认 25s）ping 全部客户端，连接收到 pong 会刷新 `isAlive`；连续两轮无 pong 判定死连接并 `terminate`。网络闪断后无需等 TCP 超时即可释放死连接，避免半开连接长期占用与僵尸 attach。

**断线内容补齐**：运行中任务的流式文本只存在 `activeProcesses` entry 的内存 `fullText` 中（落盘要等任务结束）。断线期间丢失的 `text_delta` 通过以下链路补齐：

1. 前端重连后（保留流式气泡时）发送 `load_session`
2. 服务端 `handleLoadSession` 在 `session_info` 中附带 `activeOutput`（entry.fullText 快照，仅运行中会话携带）
3. 前端在 `case 'session_info'` 中守卫补齐：**仅当 `activeOutput` 比本地流式缓冲 `pendingText` 更长时整体覆盖**，绝不倒退已渲染内容；`text_delta` 为追加语义，覆盖后后续增量继续拼接

`resume_generating`（紧随 `session_info` 之后发送）仍按替换语义恢复完整生成态，两者共同覆盖"重连补齐"与"切回运行中会话"两条路径。
