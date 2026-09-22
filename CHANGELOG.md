# 更新记录

> **本仓库是 [ZgDaniel/cc-web](https://github.com/ZgDaniel/cc-web) 的个人分叉。**
> 分叉基线是上游 `v1.3.1`，此后两边独立演进，`v1.4.0` / `v1.5.0` / `v1.5.1`
> 三个号段被双方各自用过且内容不同。为免混淆，分叉侧的条目一律加「分叉」前缀，
> 上游章节保持原样；`v1.3.1` 及更早是两边共同的历史。
> 当前版本 `1.5.1+my.1` = 上游 `v1.5.1` + 下列全部分叉改动。

---

## 分叉 v1.5.12

### 新增

- 流式气泡末尾常驻一组跳动的指示点，表示这一轮还没跑完。`v1.5.10` 修好 `tool_end` 之后工具卡片会在 0.1 秒内正确变 done（本会话 108 次调用实测 `tool_use`→`tool_result` p50 0.09s、p90 0.22s，超过 3s 的只有两次 Bash），而模型思考加生成的空档 p50 10.8s、p90 42s、最长 143s，这段时间根本没有工具在跑。以前那些永不熄灭的 running 小点其实被当成了「还在干活」的活动指示，现在它们正确停下，空档期就完全静止了，只能靠底部是「停止」还是「发送」按钮判断。

  指示点挂在 `.msg-bubble` 末尾，而不是放回 `.msg-text` 里：`flushRender` 每 100ms 就把 `.msg-text` 整个重写一遍，放进去会被第一段文本冲掉——这正是原先 `startGenerating` 那个 indicator 的下场，它只在本轮第一个字出现前可见。挂在气泡末尾则天然排在文本和工具卡片之后，`flushRender` 写 `.msg-text`、`appendToolCall` 写 `.msg-tools`，谁都碰不到它。`ensureTypingIndicator` 幂等；收尾时由 `finishGenerating` 用 `querySelectorAll` 全删，原先的 `querySelector` 只摘第一个，被 `goal_feedback` 封口过的气泡里会留下第二串。

  顺带把 `flushRender` 在空文本时的行为改成清空 `.msg-text`，而不是继续走 `renderMarkdown('')`：后者会往里再吐一个 indicator，和气泡末尾那个撞成两串点（`resume_generating` 带空 `text` 时就会踩到）。

### 验证

- 从 `public/app.js` 抽出真实的 `ensureTypingIndicator`，在最小 DOM stub 下跑 9 条断言全绿：气泡子节点顺序为 `.msg-text` / `.msg-tools` / 指示点、重复调用幂等、重写 `.msg-text` 与追加工具卡片都不影响它、指示点不会被 `.tool-call` 选择器误收、收尾后清零、折叠组提前后顺序正确、两个气泡各留一串时 `querySelectorAll` 能全删。
- 生命周期静态核对：创建点只有 `startGenerating`（`resume_generating` 复用气泡时指示点必然还在，它只可能被 `finishGenerating` 删掉，而那条路径会摘掉 `#streaming-msg` 的 id）；删除点是 `finishGenerating` 与 `goal_feedback` 封口，而 `done` / `error` / `background_done` / WS detach 兜底四条收尾路径都汇入 `finishGenerating`；全文件确认只有建气泡时的 `bubble.innerHTML = ''` 会清掉它，`createMsgElement` 那处 `bubble.innerHTML` 只作用于历史消息。
- `node --check public/app.js` 通过；`npm run regression` 因缺 `sqlite3` 仍在建表阶段就跑不起来，且该套件不覆盖前端渲染。
- 本机无浏览器，指示点与文本/工具卡片之间的间距（`.typing-indicator` 自带 `padding: 8px 4px`，现在前面可能紧跟 markdown 段落的下边距）未做实测。
- 生效前提：本笔只改前端静态文件，不必重启服务进程，硬刷新即可（静态资源 `?v=` 已打到 `1.5.1-my.18`）。

## 分叉 v1.5.11

### 修复

- 多个浏览器标签各开一个会话时，切到或切离「运行中的长会话」那个标签会卡顿数秒，越在后台待得久越明显，其它标签不受影响。三条独立成因：

  1. `visibilitychange` 原先只要 `isGenerating || currentSessionRunning || 有流式气泡` 就重发 `load_session`。但标签切后台并不发 `detach_view`，WS 全程 OPEN，流式 delta 一直在到达，历史消息树也从未被动过 —— 这次重载等于把整棵树推倒重建：`renderMessages` 开头 `messagesDiv.innerHTML = ''`，然后 12 条近期消息 + N 块 chunk 逐块经 `prependHistoryMessages` 重排，每块 3 次强制同步布局。实测一个 2197 条消息 / 1479 张工具卡片 / 782K markdown 字符 / 183 个代码块的会话要重建 92 块 chunk、约 276 次强制布局。现在只在本地确实缺流式气泡（状态不一致）时才回退到全量重载；断线恢复本来就由 `auth_result` 的重连兜底负责重新 attach 并补齐 `fullText`，这里不必重复。

  2. `scrollToBottom` 里的 `requestAnimationFrame` 没有去重守卫。隐藏标签里 rAF 被浏览器完全暂停，而 `setTimeout` 仍在跑（节流到 ≥1s，且活跃的 WS 流量会压制 intensive throttling），回调一路堆积，切回标签的第一帧集中执行，每个都要读 `scrollHeight` 再读 `updateScrollbar` 里的尺寸，两次强制同步布局。加 `scrollBottomRaf` 句柄守卫，同一帧内只留一个。

  3. 隐藏标签里 `scheduleRender` 照常每 100ms 触发 `flushRender`，而 `flushRender` 是整段 `pendingText` 的全量重解析（`marked.parse` → `DOMPurify.sanitize` → `decorateCodeBlocks`），后台白烧 CPU，还顺带堆出上面那些 rAF 回调。现在 `document.hidden` 时只累积文本、置一个 `renderPendingHidden` 标志，转回前台由 `visibilitychange` 补渲染一次。守卫只能加在 `scheduleRender`，不能加在 `flushRender`：收尾路径（`finishGenerating` / `resume_generating` / `goal_feedback`）直接调 `flushRender` 且随后就清 `pendingText`，加在那里会让后台完成的任务永久丢掉最终文本。

### 优化

- `sendSessionList` 按 mtime+size 缓存每个会话的侧栏字段。侧栏只用到 id / title / updated / hasUnread / agent / group / claudeSessionId，但会话文件里 `messages` 占体积的 99%，每次 `list_sessions` 都要全量 `JSON.parse` 一遍 —— 本机 40 个会话实测 47.20ms 的同步阻塞，而这个函数在每轮任务 `done`、导入、重命名、归组、以及每次标签转回前台时都会被调。缓存后 0.10ms。`isRunning` 只存在于内存（`activeProcesses`），不进缓存、每次实时计算；会话文件被删时同步剔除缓存条目，避免 Map 无限增长。

### 验证

- 逐条核对了改动的安全性：标签切后台不发 `detach_view`，`entry.ws` 始终有效，`pendingText += msg.text` 在 `scheduleRender` 守卫之前执行，`tool_start` / `tool_end` 本来就直接改 DOM 不走 `scheduleRender`。
- `sendSessionList` 缓存在独立副本上验过三种边界：`hasUnread` 经 `atomicWriteJson` 翻转后立即失效 ✓、等长标题改名（size 不变）靠 `mtimeMs` 的亚毫秒精度识别 ✓、删除会话后缓存条目被剔除 ✓。
- `node --check` 两个改动文件通过；`npm run regression` 因缺 `sqlite3` 仍跑不起来，且该套件不覆盖前端渲染与会话列表。
- 本机无浏览器，切标签的实际卡顿改善程度未做实测，上述规模数字来自对真实会话文件的静态统计。
- 生效前提：本笔改了服务端（`server.js`），必须重启服务进程；前端另需硬刷新（静态资源 `?v=` 已打到 `1.5.1-my.17`）。

## 分叉 v1.5.10

### 修复

- 上下文压缩正好发生在一轮对话开头时，压缩摘要会顶着灰底、全文平铺在这一轮的**最后**，刷新页面后才变成折叠卡片并回到这一轮**之前**。根因在 `lib/agent-runtime.js` 的 `case 'user'`：CLI 把摘要作为 `type:'user'` 事件吐出来，而 stdout 上的 `isSynthetic` 是 `isMeta || isVisibleInTranscriptOnly || isCompactSummary` 合并后的结果，不透传具体来源，于是摘要被当成 hook 反馈发了 `kind:'hook_feedback'`，前端 `appendSystemMessage` 把它追加到消息列表末尾。刷新走的是另一条通道——`parseJsonlToMessages` 认 jsonl 里的 `isCompactSummary`、给出 `kind:'compact-summary'`，由 `buildCompactSummaryElement` 渲成折叠块，所以同一条内容两次看到的位置和样式都不一样。

  现在实时通道按内容分流：命中 `COMPACT_SUMMARY_PREFIX`（`This session is being continued from a previous conversation`）的发新的 `kind:'compact_summary'`，前端复用同一个 `buildCompactSummaryElement`；命中 `isInjectedClaudeUserEntry` 的 caveat / `<system-reminder>` / local-command 回显直接丢弃——此前它们同样会变成一个灰色系统气泡，只是不如摘要那么显眼；剩下的才当 `hook_feedback` / `goal_feedback`。`claudeUserEventText` 同时接受裸字符串和 text block 数组两种 content 形态，同一字段在不同 CLI 版本里两种都出现过。

- 最后一次工具调用停在「灰点闪烁未完成」的状态，且卡片挂在 agent 气泡下方，刷新后才变成完成态并跑到气泡上方。根因同样在 `case 'user'`：`tool_result` 只出现在 `type:'user'` 事件里（该事件另带 `tool_use_result` 字段），而原代码在 `case 'assistant'` 的 content 里找它，`case 'user'` 又因为 `!isSynthetic` 提前 break——`tool_end` 从来没发出去过。平时看不出来是因为 `FOLD_AT=3` 的折叠组把卡片藏了起来，只有本轮工具少、没凑够一组时才裸露出那个闪烁的小点。顺带 `entry.toolCalls[].result` 也一直是空的，翻历史时展开工具卡片看不到 Output；修好后这部分开始落盘，`sessions/*.json` 会相应变大（单条上限仍是 2000 字符）。

  `tool_result` → `tool_end` 抽成 `emitClaudeToolEnd`，`user` 与 `assistant`（旧版 CLI 形态）两处共用。位置差异另修：流式侧收尾时若已折叠成组，把 `.msg-tools` 提到 `.msg-text` 前面，与历史重建的 `bubble.insertBefore(group, bubble.firstChild)` 对齐；没折叠时两边都留在文本下方，仍然一致。系统消息也不再无条件 append——`insertBeforeStreaming` 在存在 `#streaming-msg` 时插到流式气泡之前，这才是刷新后历史里的位置。

### 验证

- 用真实 `sessions/*-run/output.jsonl` 全量重放 `processClaudeEvent`：44 个 `tool_use` / 43 个 `tool_result`（全部在 user 事件里，assistant 事件里 0 个）的会话发出 44 个 `tool_start` + 43 个 `tool_end`，`toolCalls` 里 43 条 `done` 且 `result` 非空——缺的那个是重放时仍在跑的工具；另一个 31/31 的会话完全对齐。前一个会话恰好含一次压缩，其唯一的 synthetic user 事件产出 1 个 `compact_summary`、0 个 `hook_feedback`。
- 针对 `case 'user'` 的 7 组形态断言全绿：tool_result 置 `done`/`result` 并发 `tool_end`、字符串与 block 数组两种摘要都识别、`<system-reminder>` 与 `isMeta` caveat 丢弃、`Stop hook feedback:` 仍走 `goal_feedback`、普通 hook 文本走 `hook_feedback`、非 synthetic 文本不产生任何输出。
- `node --check` 三个改动文件通过；`npm run regression` 因缺 `sqlite3` 仍在建表阶段就跑不起来，且该套件不覆盖事件归一化。
- 本机无浏览器，折叠组提到文本上方之后的视觉效果未做实测。
- 生效前提：本笔改了服务端（`lib/agent-runtime.js`、`server.js`），必须重启服务进程；前端另需硬刷新（静态资源 `?v=` 已打到 `1.5.1-my.16`）。

## 分叉 v1.5.9

### 新增

- 用户与 agent 的气泡旁多一枚 11px 的分钟级时间（钉钉风格）：用户消息在气泡左下角，agent 消息在气泡右下角。鼠标悬停显示带日期的完整时间——只有 `HH:MM` 的话，回看几天前的会话分不清是哪天。

  时间元素是 `.msg` 的第三个 flex 子节点（`align-self: flex-end`），不进 `.msg-bubble`：气泡里是 markdown/工具卡片/附件的渲染结果，塞进去要么被 `p:last-child` 之类的排版规则影响，要么被会话内搜索当成对话内容高亮。左右位置不用写方向判断——`.msg.user` 本身是 `row-reverse`，同一份 DOM 顺序自然得到「用户在左、agent 在右」。同时把 `.msg-time` 加进 `SEARCH_SKIP_SELECTOR`，否则搜数字会命中一堆时间戳。

  数据全部来自已有的 `message.timestamp`（服务端各处 push 消息时早就在写，只是前端没用过），没动服务端也没动会话文件格式。导入的会话里该字段可能是 `null`，此时不渲染，也不占位。

  流式气泡的时间在 `startGenerating` 就打上（用本地时刻），`finishGenerating` 再用 `setMsgTimeText` 原地校准一次。两段都需要：若只在收尾插入元素，气泡会在每轮输出结束时被挤窄一次、正文重排；若只在开始打时间，服务端存的是进程收尾时刻的 `timestamp`，刷新页面后时间会往后跳。`HH:MM` 定宽，校准不改变布局。

### 验证

- 从 `public/app.js` 抽出真实的 `setMsgTimeText` / `buildMsgTimeElement` / `createMsgElement`，在最小 DOM stub 下跑 24 条断言全绿：零填充 `09:05`、title 带日期、时间是 `.msg` 直接子节点且在 bubble 之后、不落进气泡正文、ISO 串与毫秒数都认、`null`/空串/非法值都不渲染、system 消息不带时间、附件路径不受影响、收尾校准只改文本不改节点数；外加调用点与 `SEARCH_SKIP_SELECTOR` 的静态核对。
- `node --check public/app.js` 通过。
- 本机无浏览器，真实页面里的视觉位置与各主题下的对比度未做实测；`npm run regression` 因缺 `sqlite3` 仍跑不起来，且该套件只覆盖服务端行为。
- 生效前提：本笔只改前端静态文件，不必重启服务进程，硬刷新即可（静态资源 `?v=` 已打到 `1.5.1-my.15`）。

## 分叉 v1.5.8

### 修复

- 上翻浏览对话历史时，只要最新一轮还在输出，视口就被反复拽回页面底部，没法安静看完一段旧内容。根因是 `scrollToBottom()` 无条件把 `scrollTop` 推到 `scrollHeight`，前端完全没有「用户正在上翻」这个状态；流式期间 `text_delta` → `scheduleRender` → `flushRender` 每 100ms（`RENDER_DEBOUNCE`）就调一次，每个 `tool_start` 再加一次，于是一秒能被拽回十次。

  现在由 `stickToBottom` 一个标志决定要不要跟随，`scrollToBottom(force)` 在未贴底且非强制时直接返回。关键是这个标志只在 `messagesDiv` 的 `scroll` 事件里更新，而不是在滚动前现场测距：`flushRender` 是先写 `innerHTML` 再滚，此时容器已被新增文本撑开，现场测出的距底距离恒大于 0，24px 容差下会在「跟随 / 不跟随」之间抖动。内容增高本身不触发 `scroll` 事件，所以该标志的语义恰好是「用户最后一次把视口放在哪」，上翻期间稳定为 `false`。容差复用跳转按钮的 `JUMP_EDGE_TOLERANCE`，跟右下角「到底」箭头的显隐判定保持一致。

  跟随与否按语义分流：流式文本、工具卡片、轮次开始、系统消息与错误、外部 CLI 历史增量都尊重该标志；切会话、整区重渲染、用户自己发消息、点「到底」按钮这四类必须落底，走 `force` 并把标志置回 `true`。

  顺带删掉 `imported_messages_replaced` 里原有的局部 `wasNearBottom`——它是同一问题的旧补丁，且因为在 DOM 改动**前**测距，在「用户贴着底、内容刚增高」时会误判为未贴底而中断跟随，现在统一交给 `stickToBottom`。

  `stickToBottom` 声明放在文件顶部的全局状态区而不是 `scrollToBottom` 旁边：后者是提升的函数声明，若在 `let` 语句执行前被同步调用会撞上 TDZ 抛 `ReferenceError`。

### 验证

- `node --check public/app.js` 通过。
- 全文件确认无把 `scrollToBottom` 当回调传递的裸引用（`.then(scrollToBottom)` 之类会意外收到 truthy 实参当 `force`），三处名字命中都在注释里。
- 本机无浏览器，真实页面里的滚动手感未做实测；`npm run regression` 因缺 `sqlite3` 仍在建表阶段就跑不起来，且该套件只覆盖服务端行为。
- 注意生效前提：本笔只改前端静态文件，不必重启服务进程，硬刷新即可（静态资源 `?v=` 已打到 `1.5.1-my.14`）。

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
