# 更新记录

> **本仓库是 [ZgDaniel/cc-web](https://github.com/ZgDaniel/cc-web) 的个人分叉。**
> 分叉基线是上游 `v1.3.1`，此后两边独立演进，`v1.4.0` / `v1.5.0` / `v1.5.1`
> 三个号段被双方各自用过且内容不同。为免混淆，分叉侧的条目一律加「分叉」前缀，
> 上游章节保持原样；`v1.3.1` 及更早是两边共同的历史。
> 当前版本 `1.5.1+my.1` = 上游 `v1.5.1` + 下列全部分叉改动。

---

## 分叉 v1.5.7

### 新增

- 左侧会话列表里，每个 Claude 会话的标题下方多一行小字（11px 等宽），显示该会话在 Claude CLI 侧的 session id —— 也就是 `~/.claude/projects/<项目>/<id>.jsonl` 的文件名，不是 cc-web 自己的会话 id。

  数据源是 `session_list` 新增的 `claudeSessionId` 字段，而不是 `session_info`：列表本来就在每轮任务 `done`、导入、重命名、归组后被服务端重推，`--resume` 换了 id 也能跟上，不必新增推送通道，也不动会话快照缓存。

  id 行挂在 `.session-item` 上（`flex-wrap` 换行），而不是塞进 `.session-item-main`：后者的宽度还要跟时间戳和操作按钮分，36 字符的 UUID 会被挤断，hover 露出按钮时还会重新折行。宽度不够时整体折行而不是省略号——截断了就没法拿去对 jsonl 文件名。

  id 文本本身不吃点击，点它跟点标题一样是切会话；复制交给行尾一枚 hover 才露出的小按钮（`pointer-events: none` 落在其 svg 上，保证委托判定认得出按钮本身），复制走已有的 `copyTextToClipboard`，在内网 HTTP（非 secure context）下自动降级到 `execCommand`。按钮绝对定位到卡片右侧的内边距区、不占流内宽度：11px 字号下 36 字符的 UUID 约 238px，已经吃满 240px 的内容宽（280 侧栏 − 16 列表 padding − 24 项 padding），按钮但凡占一点宽度就会把 id 挤成两行；id 行本身再向右借 8px 内边距，给字体度量差留出余量。触屏没有 hover，所以移动端跟 ✎/⧉/× 那排一样常显。

  新建会话在首轮跑完前服务端还拿不到 id，此时不渲染这一行；Codex 会话同样不渲染（它是另一套 `codexThreadId`）。

### 验证

- 隔离目录起服务实测 `session_list`：Claude 会话的 `claudeSessionId` 原样透传且不等于 cc-web 侧会话 id，Codex 会话该字段为空串（前端据此不渲染 id 行）。
- 从 `public/app.js` 抽出真实的 `buildSessionItem`，在最小 DOM stub 下跑九例：导入的 Claude 会话出现 id 行且内容是 CLI id 而非 cc-web id、行内同时有 id 文本与复制按钮、运行中会话的「运行中」徽标与 id 行共存、无 id 的新会话与 Codex 会话都不出现该行、id 行位于操作按钮之后（即换行到第二行）、标题仍被转义；点击委托两例——点复制按钮只复制且不 `openSession`，点 id 文本只 `openSession` 且不复制。
- `node --check server.js` / `node --check public/app.js` 通过。本机无浏览器，真实页面里的视觉效果与剪贴板落值未做实测；`npm run regression` 因缺 `sqlite3` 仍跑不起来。
- 注意生效前提：`server.js` 有改动，必须重启服务进程；只刷新浏览器不够（静态资源 `?v=` 已打到 `1.5.1-my.13`）。

## 分叉 v1.5.6

### 修复

- 代码块的 Copy 按钮在内网 HTTP 访问下点了没反应。`navigator.clipboard` 只在 secure context（`https` 或 `localhost`）下存在，而本服务是纯 HTTP、通常从内网 IP 访问，该对象是 `undefined`，`writeText` 直接抛 `TypeError`；原来的 `.then()` 没有 `.catch()`，异常只进控制台，按钮文字和剪贴板都没有任何变化。

  现在优先走 `navigator.clipboard`，不可用（或 reject）时降级到临时 `<textarea>` + `document.execCommand('copy')`。降级必须留在 click 的同步调用栈里，`execCommand` 一旦脱离用户手势就会被浏览器拒掉。复制失败时按钮显示 `Failed`，不再静默。

  与代码块语言无关，此前所有语言的 Copy 都是坏的；同一代码块上的 Preview 按钮一直正常，因为它不碰 clipboard。

### 验证

- 浏览器实测：无语言 fence、显式 `plaintext`、`js`、`python`、`html` 五种代码块的 Copy 均恢复，粘贴内容与块内文本一致，`html` 块的 Preview 不受影响。本机缺 `sqlite3`，`npm run regression` 仍跑不起来。

## 分叉 v1.5.5

### 新增

- 输入框左侧新增模型徽标，常驻显示当前会话的模型与思考强度（`模型 · 强度`），未显式设过强度时显示「默认」。Claude 侧取 `/model` 与 `/effort` 的当前值，Codex 侧从模型名的 `(level)` 后缀里拆出强度；点击徽标等同于 `/model`，可直接改模型和强度。

  服务端下发的 Claude 模型名是 `opus` / `sonnet` / `haiku` 槽位别名，徽标上再用
  `model_options` 带来的 `aliasModels` 还原成真实模型名（已剥 `[1m]` 后缀，与终端
  `/model` 的显示口径一致），槽位名退到 tooltip 里。`aliasModels` 需要等网关响应，
  通常晚于 `session_info` 到达，因此目录到手后会补刷一次徽标。

  导入会话的 `model` 可能为空（终端侧没写模型字段），此时徽标显示「默认模型」，
  只有在欢迎页（没有会话）才整个隐藏。

### 修复

- 会话快照解析漏掉了服务端下发的 `effort` 字段，导致切换会话后前端记录的思考强度被清空（`/effort` 再查才恢复）。

### 验证

- 端到端覆盖 `session_info` 携带 `effort`、`/model <模型> <effort>` 同时回带两项、`/effort` 单独切换、重新 `load_session` 后强度保留，以及 `model_options.aliasModels` 能把槽位名还原成剥掉 `[1m]` 的真实模型名。本机缺 `sqlite3`，`npm run regression` 仍跑不起来。

## 分叉 v1.5.4

### 修复

- Codex `local` 会话不再被隔离到独立的 `CODEX_HOME`。此前浏览器下发的轮次会落入隔离目录下的 rollout，一旦重开浏览器，因原生 `~/.codex` 里没有该轮次而丢失。现取消 `local` 会话的 `CODEX_HOME` 隔离，浏览器下发的轮次直接写入原生 rollout，与 Claude Code 的行为对称。

### 加固

- 导入会话同步新增“更短不覆盖”保护：仅当重新解析得到的消息数不小于既有总数时才替换，避免在 rollout 被截断或原子替换的瞬间读到更短内容、覆盖掉已渲染的消息。

### 验证

- 回归新增护栏用例覆盖上述“更短不覆盖”场景，`npm run regression` 全绿。

## 分叉 v1.5.3

### 修复

- Codex 导入会话现在可以识别真实 rollout 中的 `custom_tool_call` 与 `custom_tool_call_output`，终端通过 MCP/自定义工具产生的调用、完成状态和输出会同步到浏览器。
- 文件监听器现在可以检测 rollout 文件被原子替换、truncate 或 inode 变化，自动从新文件重新读取，避免长时间运行时漏掉后续 CLI 输出。

### 验证

- 回归覆盖 Claude 追加同步、Codex 追加同步、Codex 同长度工具结果更新、`custom_tool_call` 输出、rollout 原子替换、token usage 持久化及本地 rollout/SQLite 删除清理。

## 分叉 v1.5.2

### 修复

- Codex 导入会话现在会与终端 CLI 实时同步

  v1.5.0 的实时同步链路只识别 `claudeSessionId`，监听目标也固定为
  `~/.claude/projects/.../*.jsonl`；Codex 导入会话保存的是 `codexThreadId` 与
  `importedRolloutPath`，因此虽然可以导入快照，却从未启动 rollout watcher。

  现在会按 Agent 选择原生历史源：Claude 继续监听 project JSONL，Codex 监听
  `~/.codex/sessions/.../rollout-*.jsonl`。打开会话时先补齐遗漏内容，打开期间的
  新用户消息、助手回复、工具调用结果和 token usage 会在 400ms 防抖后同步到浏览器。

  Codex rollout 可能在消息条数不增加时补写当前助手消息或工具结果，因此新增了
  “变化后缀替换”协议；纯追加仍沿用原事件以保持兼容。前端只重绘变化位置之后的
  消息，DOM 状态不一致时自动做一次非阻塞重载，避免重复或漏消息。

- 首次导入 Claude/Codex 会话后立即启动 watcher，无需切走再重新打开；切换会话、
  detach、断开连接或删除会话时同步释放订阅。

### 验证

- 隔离回归覆盖 Claude 追加同步、Codex 追加同步、Codex 同长度工具结果更新、
  token usage 持久化及本地 rollout/SQLite 删除清理。

## 分叉 v1.5.1

### 新增

- 模型与思考强度（effort）可切换，候选列表从网关动态获取

  此前 `/model` 只认写死的三个别名（opus / sonnet / haiku），网关上实际可用的
  几十个模型选不到；claude 的 `--effort` 参数则完全没接，思考强度无法调整。

  现在候选列表改为向网关的 `/v1/models` 端点动态获取（5 分钟缓存），过滤掉
  embedding / reranker / OCR 这类无法用于对话的模型，Claude 原生模型排在前面。
  网关不可达时回落到内置别名，选择器始终有内容可用，不阻塞切换。

  `/model` 改为两级联动：先选模型、再选 effort，一次点完；也支持
  `/model <模型> <effort>` 一条命令同时设定。新增 `/effort` 用于只调强度。
  两者的合法值取自 `claude --help` 的权威列表（low / medium / high / xhigh /
  max），另有 `default` 哨兵值用于清除设置、交回 CLI 默认。

  别名仍然可用且优先解析，因此 `/model opus` 的行为不变。未指定 effort 时保留
  会话原有设置，不会被静默重置。`session.effort` 随会话持久化，并跟随
  `session_info` 快照下发，切换会话时前端状态不会残留。

## 分叉 v1.5.0

### 新增

- 导入会话实时同步：终端 CLI 侧产生的消息会实时同步到浏览器端

  从终端 CLI 导入的会话（带 `importedFrom` 与 `claudeSessionId`），正文由
  claude CLI 写入 `~/.claude/projects/<projectDir>/<claudeSessionId>.jsonl`。
  在终端里继续同一个 CLI 会话时，新消息只进 JSONL 不进 cc-web 的会话文件，
  浏览器端因此看不到进度，也无法判断会话是否已完成。现在做两件事：

  - 打开会话时重新解析 JSONL，补齐此前遗漏的消息
  - 会话打开期间监听 JSONL 变更，新增消息实时推送并追加渲染

  实现上复用已有的 `FileTailer`（`fs.watch` + 500ms 轮询兜底），变更后 400ms
  防抖再解析，避免 CLI 高频写入时反复全量解析。同一会话的多个客户端共享一个
  监听器，按订阅计数启停，最后一个订阅者断开时释放。会话正在 cc-web 侧运行时
  跳过同步，正文仍由流式事件推送，不会重复。

  JSONL 是超集：cc-web 侧发出的消息同样会被 CLI 落盘，因此整体重解析可以安全
  覆盖，不会丢失经由 cc-web 产生的内容。合并时按位置回填 `attachments` 等
  cc-web 独有字段。

- 长会话跳转：消息区右下角提供「到最前 / 到最后」圆钮

  长会话里逐屏翻找很费劲。现在只显示可去的方向：处于中间时两枚都在，滚到
  最前只留「到最后」，滚到最后只留「到最前」；内容不足两屏时整组不出现，
  短对话里不干扰。距边缘 24px 内视作已到顶/到底，避免像素级抖动导致闪烁。

  状态计算并入既有的 `updateScrollbar()`，不新增滚动监听。服务端打开会话时
  一次性推完全部历史块，DOM 内即全量消息，跳转只需设 `scrollTop`，不触发额外
  加载。跳转采用瞬时定位而非平滑动画：数百条消息的长距离 smooth 滚动耗时数秒
  且中途难以打断。

### 修复

- 任务完成结果在浏览器端可能完全收不到

  `handleProcessComplete` 判断客户端在线只用了 `!!entry.ws`，没有检查
  `readyState`。socket 已进入 CLOSING/CLOSED 但 `close` 事件尚未触发
  `handleDisconnect` 时（进程退出回调或 2 秒 PID 巡检抢在同一 tick 之前），
  会走进「在线」分支，而 `wsSend` 对非 OPEN 状态是静默丢弃，于是 `done`、
  错误信息、系统消息全部丢失，`background_done` 兜底分支也永不触发。改为
  `!!entry.ws && entry.ws.readyState === 1`，与同一函数内 `shouldAutoCompact`
  等处既有的判活写法保持一致。该值同时用于日志，此前会出现 socket 已失效却
  记为 `wsConnected: true` 的误导。

- 任务完成只通知发起的标签页，其他标签页与设备无感知

  完成结果仅推给 `entry.ws`。现在抽出 `broadcastBackgroundDone()`，在线分支
  推完 `done` 后广播给其余客户端并排除自己，离线分支复用同一实现。前端收到
  `background_done` 时：正在查看该会话则重载，否则刷新会话列表。

## 分叉 v1.4.0

### 新增

- 钉钉机器人通知通道：支持自定义关键词安全设置，可选发送时 @所有人
- `HOST` 配置项：可指定服务监听地址，默认 `127.0.0.1`，设为局域网 IP 即可供内网访问

### 修复

- 修复自建网关/第三方中转场景下会话报 `Not logged in · Please run /login`：
  子进程环境过滤原会删除全部 `ANTHROPIC_*` 变量，导致 CLI 丢失凭据，
  现改为白名单保留 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_API_KEY` / `ANTHROPIC_CUSTOM_HEADERS`
- 修正登录封禁提示文案：实际封禁时长为 7 天，原文案误写为「永久封禁」

---

## v1.5.1

### 新功能

- **会话分组管理**：左侧会话列表支持分组——点“+ 分组”直接创建（自动命名“分组1、分组2…”，重名自动跳号），点击分组名称即可修改；会话可**拖拽到分组标题**完成归档（手机端无拖拽，每个会话提供“归组”按钮）；点击分组标题可**收起/展开**该分组，收起状态自动记忆；删除分组时会**连同组内全部会话一起删除**，删除前弹确认框并明确显示会话数量
- **Cloudflare API 接入**：设置的开发者配置新增 Cloudflare 卡片（API Token + 域名清单管理）；新增 `/cf` 命令，用自然语言即可让 AI 查询和管理 DNS 解析、域名等（如 `/cf 查看 example.com 的 DNS 记录`）；Token 在界面全程以掩码显示，明文绝不写入聊天记录

### 修复

- **会话时间“集体同秒”**：保存模型配置后，所有会话的“最后活跃时间”会被统一刷新成保存那一刻，导致列表时间和排序全部失真；现已根治，历史被污染的时间也已按各会话最后一条消息恢复
- **任务偶发“秒完成、无回复”**：上一个任务收尾的瞬间若正好发出新任务，新任务的回复可能凭空丢失、界面直接显示完成；现已根治

### 体验改进

- 新建分组、新建 Claude 模板不再弹出浏览器原生输入框（系统样式的那种小窗），改为自动命名后直接打开应用内编辑窗口，与 Codex 的体验一致
- 网页资源加载带版本号，版本更新后浏览器不再使用旧缓存

## v1.5.0

### 新功能

- **`/loop` 定期执行**：让 AI 按设定间隔自动执行任务（如 `/loop 10m 检查部署状态并汇报异常`），间隔从 1 秒到 24 小时；上一轮任务没跑完时自动跳过本轮、不会叠加执行；设置随会话保存，服务重启后自动恢复；`/loop off` 随时停止
- **Codex 支持 `/goal`**：建立并持续维护目标，Claude 与 Codex 双端用法一致

### 修复

- **断线时输入内容凭空消失**：连接闪断的几秒内发送消息，此前会被无声丢弃、界面假装"运行中"随后一切如常消失。现在断线期间内容保留在输入框、聊天区顶部亮起连接状态提示，重连成功后提示自动消失、可立即重发
- **长任务画面卡死十几分钟**：连接闪断会造成输出"黑洞"——任务实际在跑、界面却长时间无显示，任务结束时记录才一次性涌出。现在断线重连后界面会自动补齐缺失内容，实时恢复

### 体验改进

- **连接更稳**：服务端主动保活连接，失效连接秒级发现清理，从源头减少闪断
- **长会话自动压缩（三级保障）**：① 接近上下文上限时提前自动压缩，不打断任务 ② 万一超限，自动压缩并重放你刚才的消息，不再需要手动 `/compact` ③ 压缩过程在页面显示提示（含压缩前后占用变化）
- **任务完成不打断阅读**：回复完成后不再自动滚动到底部、不强制刷新当前会话
- **Codex 会话续接失败自愈**：历史会话因工具记录无法回放而报错时，自动重建上下文并重试本次请求
- **后台会话完成即时可见**：会话列表实时刷新完成状态

## v1.4.0

### 安全加固（5 大目标）

- **鉴权系统现代化**：密码改 scrypt 哈希（`N=16384 r=8 p=1`）+ 16 字节随机 salt；token 改 sha256 指纹存储（绝不落盘原始值），新增 24h 滑动续期 + 7 天绝对过期；改密走 `revokeAllTokens` 原子封装（先空 `tokens.json` → 再写 hash → 签新 token），任意点崩溃都不会出现「密码已改但旧 token 仍可用」
- **改密踢下线**：A 标签页改密后，B 标签页等所有其他已认证 WS 连接立即被关闭（前置 `_ccwebAuthed=false` 防 close race），旧 token 失效，旧 WS 重连时被踢回登录页
- **聊天内容 XSS 纵深防御**：marked 解析 → **DOMPurify sanitize**（fail-closed：未加载时降级 `<pre>escape</pre>`）→ decorateCodeBlocks 用 DOM API 注入 Copy/Preview 受信任 UI；兜底为统一 CSP 响应头（禁止 `unsafe-inline`、`object-src 'none'`、仅允许 cdnjs CDN）
- **客户端 IP 解析加固**：默认**完全不信任** `X-Forwarded-For`（防 XFF 伪造绕过 IP 封禁）；新增 `CC_WEB_TRUSTED_PROXIES` 环境变量，配置后启用「XFF 链 + socket，从右往左跳过可信代理」标准算法；非法 IP token 污染整条 XFF 链时整体丢弃回退 socket
- **HTTP `/api/*` 前置封禁**：被封 IP 调用 API 直接返回 403，不消耗 token 验证算力
- **长期健壮性**：所有 session / config 落盘改走 `atomicWriteJson`（tmp + rename），含密钥的 `dev.json` / `codex.json` / `notify.json` / `auth.json` / `tokens.json` 强制 `0600`；中断按钮改用 `kill(-pid)` 杀**整个进程组**，避免孙子进程变孤儿继续烧 token

### 体验改进

- **WS 重连不打断阅读**：前端 `hasInitialAuthCompleted` 区分「首次鉴权成功」与「重连鉴权成功」，重连不再触发会话列表/历史重载，保留用户当前滚动位置与正在浏览的旧消息

### 文档

- 新增 `docs/ARCHITECTURE.md` 「安全防御层」（8 层纵深防御表 + 兜底）与「前端渲染管线」（marked → DOMPurify → decorateCodeBlocks 流程图）
- 新增 `docs/RUNTIME.md` 「原子写」「中断进程组」「WebSocket 重连与改密踢下线」三节
- 新增 `docs/PROTOCOL.md` 「HTTP 响应头」「/api/* 前置封禁」「客户端 IP 解析」「鉴权握手细节」四节
- 新增 `docs/CONFIG.md` 「客户端 IP 解析（防 X-Forwarded-For 伪造）」整节
- 更新 `README.md` / `README.en.md`：Nginx 反代示例补 `X-Forwarded-For $remote_addr` 清洗行 + `CC_WEB_TRUSTED_PROXIES` 配置说明

### 测试

- `scripts/regression.js` 新增 7 项独立断言模块：改密原子失效集成、token 迁移单元、CSP + DOMPurify + 无内联 onclick、WS 重连不重渲染、原子写 + 进程组 kill + 旧 token 拒绝、XFF 纯函数 8 case、IP 封禁 trusted_proxies 场景

## v1.3.1

### 新增

- Codex 模型配置：支持通过配置动态管理可选模型
- 浏览器标签页：新增站点 favicon

### 修复

- 修复长时间运行服务中的内存泄漏风险
- 修复新建会话时本地目录输入与选择状态不同步的问题
- 修复 Claude 认证 token 处理异常的问题

## v1.3.0

### 新增

- 开发者配置：新增 SSH 主机管理（支持密钥/密码认证），新增 /ssh 命令便捷连接远程主机
- 开发者配置：新增 GitHub Token 与仓库管理，新增 /github 命令快速提交仓库
- 设置面板：统一 Claude 与 Codex API 配置到同一面板
- 设置面板：新增"本地配置"模板化机制，支持读取/快照/恢复本地 API 配置
- 新建会话：新增"本地任务/远程任务"选择，支持固定目录和 SSH 远程主机

## v1.2.12

### 修复

- 修复 Claude opus/sonnet 会话在切换自定义 API 模板后因模型名 `[1m]` 后缀不匹配导致 403 报错的问题
- 修复编辑模板模型名或删除模板后，已有会话的模型名无法正确重映射的问题

## v1.2.11

### 改进

- Claude 默认设置为 1M 上下文（opus / sonnet 自动使用 `[1m]` 模型，haiku 保持不变）

## v1.2.10

### 改进

- 实现与原生 claude code / codex cli 一致的 `/init` 功能

## v1.2.9

### 新功能

- **通知 AI 摘要** — 任务完成时调用 Claude API 生成摘要内容推送，支持正常完成/异常/上下文压缩等多种情况分类，摘要 API 凭证可独立配置或复用活跃 Claude 模板/Codex Profile，各渠道按字符限制自动截断，摘要失败时降级为原始信息
- **通知配置收进二级菜单** — Claude 和 Codex 设置面板中的通知区域改为 nav-card 入口，点击进入独立子页，与主题设置风格统一

## v1.2.8

### 新功能

- **Codex 双 Agent** — 新建会话时可选 Claude 或 Codex，共享后端内核，侧边栏按 Agent 隔离
- **图片上传** — 拖拽 / 粘贴 / 附件按钮上传图片，客户端自动压缩，单条消息最多 4 张
- **主题系统** — 新增 CoolVibe Light 等多套主题，设置中一键切换
- **Codex 本地历史导入** — 导入 `~/.codex/sessions/` 下的会话历史
- **隔离式回归脚本** — `npm run regression` 使用 mock CLI 在临时目录中校验主路径

### 改进

- 会话加载增加遮罩与热缓存，减少切换卡顿
- 移动端侧栏支持右滑唤起 / 左滑关闭
- 后端 spawn 与事件解析拆分为独立模块

### 修复

- 切后台再切回时运行中内容短暂消失
- 移动端附件按钮、新会话按钮比例失调

## v1.2.7

- 导入本地 CLI 会话（`~/.claude/projects/`），可续接历史对话
- 新建会话时指定工作目录
- 设置面板新增「检查更新」

## v1.2.6

- 工具调用超过 5 个时自动折叠
- 模板编辑弹窗支持拉取上游模型列表
- AskUserQuestion 选项预览区
- 自定义滚动条，会话历史分批渲染
- 修复配置文件写入竞争导致的随机 401
- 修复流式输出与工具调用 UI 共存时的覆盖问题
- 删除会话时同步清除本地 CLI 历史

## v1.2.3

- 模型配置系统：local / custom 两种模式，支持多 API 模板切换

## v1.2.2

- `/compact` 对齐 Claude Code 原生压缩策略
- 上下文超限时自动压缩并重放失败请求

## v1.2.1

- 修复 AskUserQuestion 交互选项不显示的问题
- 点击选项快捷填充到输入框

## v1.2

- 修复长代码块导致页面横向溢出
- 移动端回车改为换行，发送改为按钮触发

## v1.1

- Windows 环境兼容支持
