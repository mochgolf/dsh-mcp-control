# Agent Note: MCP 控制端点 —— 让本机 MCP 客户端驱动已知的 DSH 会话

Status: implemented

[English](design.md) | 中文

## Problem

同一台机器上的 MCP 客户端——Codex、另一个 agent、维护脚本——需要在已经运行的 DSH Web 实例中启动工作、观察它并读取其 durable 历史，而不使用浏览器，也不引入第二套控制平面。harness 已经通过 `dsh-mcp-client` 对外提供 MCP，但自身没有暴露任何 MCP 接口，因此驱动 Web 实例的唯一途径是浏览器界面及其 `/api` Remote，而 MCP 客户端两者都不会说。

Session Controller 与 subagent 运行时已经拥有这类客户端所需的全部操作：创建并提示根会话、取消其轮次、列出 durable descendant 树、向 continuable child 投递、经其 parent 中断它，以及分页读取 durable 事件日志。缺失的只是一层把 MCP 调用映射到这些服务的传输，而不为任务状态发明第二个事实来源。

## Decision

### 形态

一个可选插件 `@mochgolf/dsh-mcp-control`，设计为通过 patch overlay（`examples/cordis.yml`）加载进 DSH Web profile。它经 `ctx.effect(() => ctx.webServer.register(...))` 在共享的 `ctx.webServer` 上注册一条精确路由。没有 daemon、没有第二个 `createServer()`、没有私有 wire client，也没有 stdout scraping；路由跟随 Web 实例自身的 host 与 port，当该绑定不是 loopback 时加载失败。

插件注入 `webServer`、`agents`、`sessionController`、`subagents`、`credentials`、`workspaceRegistry`、`sessions` 与 `permissionPresets`。它不发布 `./invariant` 伴随包：它不持有任何可能被独立观察出分歧的持久化或内存投影，因此它转发的每种关系都已经在 DSH 拥有它们的地方可观察。

### 控制工具，没有任务状态

`session_start`、`session_send`、`session_cancel`、`agents_list`、`child_send`、`child_interrupt` 与 `events_read` 使用拥有相应效果的 Session Controller、Permission Preset 与 subagent 方法。`child_send` 使用 `ctx.subagents.prompt` 并固定 `mode: continuable`，`child_interrupt` 使用 `interruptByParent`，因此 live direct parent 要求与 parent 授权校验留在已经实施它们的服务中。`agents_list` 原样转发原生 durable 条目（含 diagnostic），且从不重编号。`session_start` 只接受完全限定的 `cwd`，规则与 Workspace Registry 规范化路径时所用的相同：Windows 盘符根路径或 UNC 路径会被接受，而 `\repo`、`/home/me/repo` 这类根相对路径——`node:path.isAbsolute` 会接受，但会按 DSH 进程当前盘符解析——会被拒绝。目录必须已存在且确为目录，并在调用 DSH 之前检查，因为会话创建会把缺失的目录建出来：没有这项检查，拼错的路径或客户端已经删除的工作树会悄悄在一个新的空文件夹里开始工作。它通过 `workspaceRegistry.resolveByPath` 查询现有的规范路径所有者，再把该工作区 id 交给 Session Controller；查询未命中或路径解析失败时仍走原来的 `cwd` 路径，而且除非启用 `autoRegisterWorktrees`，不会创建工作区。链接 git 工作树（直接读取其 `.git` 文件与 `commondir` 识别，不运行 git）永远不会匹配到其主检出的工作区：传入该工作区 id 会让主检出成为会话的 `cwd`，本应在隔离工作树中进行的工作就会落进用户的主工作树。回执改为给出主检出及其工作区；可选的 `autoRegisterWorktrees` 只登记确切的工作树根目录，因为成员关系是规范路径的完全匹配。当 `workspace-write` 会话的仓库元数据位于 `cwd` 之外时，回执附带 `git-metadata-outside-cwd` 警告——沙箱的可写根只有会话目录与临时区域，因此文件修改能够成功，而对 index、refs 与 objects 的 git 写入不能。可选的 `permission_preset` 会在创建前按部署提供的原生名称校验，并在已发布会话收到首条提示词之前应用。回执会暴露解析后的目录、工作区身份、Agent preset 与实际 permission preset，客户端可在后续调用前核对上下文。它还在调用 `create` 之前自行选定会话 id，因为超过本次调用截止时间的 create 仍可能完成：否则客户端手里没有任何办法寻址该会话——接口没有枚举能力，重试还会再建一个。调用方提供 `request_id` 而未提供 `session_id` 时，id 由该 `request_id`、规范化后的 `cwd` 与提示词派生，因为丢失回执的途径不只截止时间：服务端无从得知无状态客户端已经放弃，被放弃的调用仍会创建会话并提交提示词，只有命中同一 id 的重试才能避免第二个会话重复执行同一任务。提示词进入派生键，是为了让复用旧关联 id 的新任务不会落进旧会话——在那里它的提示词会被当作重复消息确认后丢弃。

每个回执报告的都是原生服务报告的内容。`accepted: true` 意味着 DSH 接收了工作；它绝不意味着某个轮次已结束、队列顺序得到承诺，或某个 child 已经存在。插件从不重试、从不保存 job、从不把 session 映射为 task，也从不创建 child——模型自己的 subagent 工具负责创建，端点只观察结果。

### 看清轮次为何没有结束

只读日志的调用者分辨不出：轮次是仍在计算，还是被只有人类才能在 Web UI 中回答的审批阻塞，抑或提示词因为 `session_cancel` 留在收件箱里而从未开始——而这条提示词之后会在任何其他提示词唤醒 Agent 时执行。`session_status` 在不激活会话的前提下回答这个问题：它通过 Agent registry 读取已挂载 Agent 的状态与收件箱，把日志尾部向前折叠到最近的 `turn/start` 以得出该轮次的状态，并列出未结束轮次中没有对应 `approval/decided` 的 `approval/asked` 事件。收件箱在取水位线之前读取，因此在两者之间被领取的提示词会出现两次，而不会一次都不出现。它在调用之间不保存任何东西。`session_cancel` 接受 `clear_queue`，在中断之前通过控制器自身的 `updateQueue` 移除等待中的提示词，使所有权检查与提示词上传的回收仍由 DSH 负责；默认行为仍与原生 cancel 一样保留收件箱。

### 无损读取不新增工具

`events_read` 从调用方的 `after_seq` 向前分页，而这是唯一存在的游标：插件在请求之间不保留 listener、snapshot 或缓存，因此端点重启不会改变客户端续读的方式。每页以完整的 `CallToolResult` 字节预算为界，交付能够容纳的最大连续前缀，并停在读取开始时取得的水位。单个事件大到装不进一个结果时，以 `oversized_event` 连同字节长度与 SHA-256 报告，并用同一个工具的 `chunk` 模式取回；该模式绝不推进分页游标，客户端游标在重组出的字节通过校验后才移到 descriptor 的 `seq`，因为 `next_seq` 会有意停在调用方自身的位置。请求的 `max_bytes` 大于结果预算时，按该预算允许的最大分片返回：base64 与 JSON 在任何尺寸被测量之前就会分配数倍于切片的字节，因此预算必须约束读取本身，而不只是约束最终答案。除 SDK 自身的输入校验之外，工具 schema 还实施地址、游标与摘要规则。

只关心某条提示词结果的协调端使用 `turn_result`，而不是自己分页。它从水位线向前读取日志尾部，直到拿到携带该提示词 `request_id` 的 `user/message` 及其之前的 `turn/start`，再把该轮次折叠成一种状态：已结束（附原生结束原因、最后一条 assistant 文本与工具失败）、仍在运行、被没有决定的 `approval/asked` 阻塞、在 live 收件箱中排队，或未找到。有界等待的上限低于请求截止时间，使调用总能作答而不是超时；它由会话自身的 `session/event` 与 `agent/status` 通知唤醒而非轮询，轮次一旦结束或被阻塞就立即返回，并在短暂宽限期内报告空闲 Agent 上排队的提示词，因为没有任何东西会启动它。早先的客户端收集脚本通过 HTTP 做同样的事；它已被移除，因为 Codex 这类沙箱化 agent 默认既不能从 shell 打开回环连接，也看不到命令环境中名字含 `TOKEN` 的变量，而 `turn_result` 走的是客户端已经持有的 MCP 连接。

### 配置与防护

`path`、`tokenRef`、事件条数上限、请求体与结果字节预算、默认分片大小以及单次调用超时都是经过校验的部署字段；工具集合、loopback 绑定与无损透传是固定的。若路由路径不是共享 WebServer 实际匹配的规范 URL 拼写，或单次调用超时超过 Node 可调度的最大延时，或凭据超出 RFC 6750 Bearer `b64token` 字符集，则在加载期失败，而不是拖到第一次请求。接收检查在任何 DSH 服务可触达之前完成：`Host` 头必须指向监听器自身的 loopback 权威，若带 `Origin` 则必须等于本端点 origin，跨站 fetch 元数据与转发头被拒绝，bearer token 与仅针对该请求解析出的凭据做常量时间比较，请求体上限按实际接收的字节数计量。接收阶段属于插件的 in-flight 集合；卸载会结束仍在其中的每个请求——正在到达的请求体，以及 SDK 仍在向停止读取的客户端写入的响应，都靠这次终止结算——然后才等待该集合并关闭 SDK handler，因此没有请求能比端点存活更久，也没有任何 Agent 被停止。

### 统一的完整结果预算

`maxToolResultBytes` 按完整的 `CallToolResult` 计量——text 兜底与 `structuredContent` 一并计入——每条路径都必须在其内作答，包括插件无法自行构建的那个结果：MCP SDK 自己的输入校验失败，其文本会回显违规参数。注册的工具 schema 仍是调用方的 zod schema，只是包在官方 Standard Schema 扩展点之后：SDK 依然校验、依然原样对外声明，只有渲染出的诊断被限长；被缩短的诊断会说明它替换掉了多少字节。原生失败的公开 details 装不下时，会退化为 `result-too-large`，保留预算容得下的关联字段，并用 `details.omitted` 列出被丢弃的字段，因此调用方总能知道结果被限长以及丢失了什么。

### 边界

端点从不回答 approval、ask-user 或 elicitation 请求，因此需要人工应答的任务并非无人值守。冷的直接 parent 会被拒绝（`subagent/parent-unavailable`），而不是被恢复。仅分页 header 或 descendant 树本身超过结果预算时会被拒绝，而不是截断。它不在 `ctx.tools` 上注册任何内容：控制工具面向 MCP 客户端，从不面向模型。

## Alternatives considered

**独立端口上的 bridge daemon。** 单独进程可以持有 MCP 会话并代理到 DSH，但它会重复 Web 实例已经拥有的生命周期、凭据与路由，还需要自己的进程监督。在既有监听器上提供服务让端口与进程生命周期保持单一拥有者。

**复用现有 `/api` Remote 的私有 wire protocol。** 复用浏览器的 Remote 会让端点依赖客户端一侧的 wire 细节与 cookie，而不是一份文档化的协议；插件改为使用官方 MCP v2 server 及其背后的原生服务。

**带自有数据库的 job/task 状态机。** 把 session 映射为 job 会给客户端一套 DSH 并不拥有的状态词汇，而它的每一种朴素实现都会在取消、排队与崩溃上撒谎。端点报告原生回执，并让调用方读取会话日志来获知结果。

**为分片取回增加第八个工具。** 单独的工具会让接口面积翻倍，并把一套寻址方案拆到两个名字上。分片模式是 `events_read` 的第二种请求形式，共用其地址与摘要规则。

**把控制工具发布给模型。** 把它们注册到 `ctx.tools` 会让模型也能控制会话，并让它们进入每次请求的工具 schema。唯一预期调用方是 MCP 客户端，因此这些工具只存在于 MCP 一侧。

**在随包发布的 Web 组合中默认启用。** 默认启用的控制端点会给每个 Web 实例一个可用 bearer token 寻址的控制面。它保持为部署方主动插入的 overlay。

## Consequences

bearer token 等同于该实例可按 id 寻址的每个会话的完整控制权：没有按 token 的 ACL、没有 cwd 白名单，端点也不是为远程或多用户部署构建的。这是保持转发层小而诚实、不引入第二套策略引擎的代价。

由于端点不保存状态，它无法提供 DSH 本身没有的东西：没有会话枚举、没有 parent 自动恢复、没有审批应答、没有超出单个超大事件之外的结果分页，进程退出后也不恢复计算。它确实带来的价值是：本机 MCP 客户端可以驱动真实会话、按 DSH 暴露的原样读取 durable 日志，并在插件重载后从自己的游标重连续读——每一项效果都可以从会话日志与文件系统核验，而不是依赖模型自己的叙述。

## Testing

CI 在 Linux、Windows 与 macOS 上分别以 engines 下限（Node 22.19）和 Node 24 运行包内测试，使路径规则、git 布局读取与对时序敏感的等待在插件声称支持的每个平台上都得到验证。包内测试让端点跑在真实 Agent Loop、Session Controller、subagent 运行时、JSONL 持久化与共享 WebServer 上，覆盖防护、凭据轮换、卸载与重载、Agent 运行中的重载、每个工具的成功与拒绝路径、游标语义、字节预算与分片重组。状态用例覆盖带排队与 steer 提示词的运行中轮次、被 cancel 滞留的提示词，以及带未决审批的未结束轮次，并证明 `clear_queue` 能保证被取消的提示词永远不会执行，而默认行为会让它在下一条提示词唤醒 Agent 时执行。配置用例断言加载期的拒绝，包括 WebServer 永远匹配不到的路由路径、计时器永远无法调度的超时，以及任何请求都无法呈现的凭据；另外，路径谓词在每个主机上同时按 POSIX 与 Windows 两套规则断言，不存在、是文件或非完全限定的 `cwd` 都被证明会在会话创建之前被拒绝且不留下目录；一个用例证明超过截止时间的 create 仍会报告 DSH 实际收到的那个 id、且该会话确实落在该 id 下，权限用例则证明 preset 会在 prompt 接收前完成校验与应用。分片大小上界既有直接断言，也有端到端断言：不受限的 `max_bytes` 返回的正是结果预算允许的那个分片。卸载针对「响应读到一半就不再读取」的客户端做了证明：写入触发背压，卸载仍能完成，共享监听器继续服务其它路由，全程运行的 Agent 未受影响。结果预算经 HTTP 在允许的最小预算下验证，覆盖多字节与大量转义字符的关联值、被切在代理对中间的诊断，以及比整个预算还长的未知参数名。工作树用例构造真实的 `git worktree` 布局——如 Codex 那样位于主检出之外、嵌套在主检出之内、游离 HEAD，以及它们的子目录——并证明会话以工作树作为 `cwd`、永远不加入主检出的工作区、只在 `workspace-write` 下发出警告，且自动登记恰好覆盖工作树根目录一次。`turn_result` 用例在真实 loop 上覆盖每一种状态——调用等待期间结束的轮次、排在运行中轮次之后并被跟踪到其自身轮次的提示词、在宽限期内报告的滞留提示词、等待中途被审批阻塞的轮次、工具失败诊断、通过 subagent 地址访问的 child——并证明超出预算的最终消息会在码点边界截短，以及较短的请求超时会让等待以作答而非超时结束。随包发布的 Web profile 通过官方 MCP 客户端经 HTTP 做端到端验证，并新增录制会话快照（`snapshots/web/mcp-control/`），用真实 `dsh web` profile 驱动端点：根会话、由模型原生创建的 continuable child、向 child 投递、原始工具事件、重连后的游标续读，以及独立的 `workspace.expected/` 核验，全部以无密钥回放执行。重启用例证明已提交日志仍可读、冷 parent 被拒绝、parent 经原生方式恢复后 child 重新可控；真实模型用例覆盖文件写入任务、原生创建 child 与向 child 投递。
