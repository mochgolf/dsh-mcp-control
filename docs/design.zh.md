# Agent Note: MCP 控制端点 —— 让本机 MCP 客户端驱动已知的 DSH 会话

Status: implemented

[English](design.md) | 中文

## Problem

同一台机器上的 MCP 客户端——Codex、另一个 agent、维护脚本——需要在已经运行的 DSH Web 实例中启动工作、观察它并读取其 durable 历史，而不使用浏览器，也不引入第二套控制平面。harness 已经通过 `dsh-mcp-client` 对外提供 MCP，但自身没有暴露任何 MCP 接口，因此驱动 Web 实例的唯一途径是浏览器界面及其 `/api` Remote，而 MCP 客户端两者都不会说。

Session Controller 与 subagent 运行时已经拥有这类客户端所需的全部操作：创建并提示根会话、取消其轮次、列出 durable descendant 树、向 continuable child 投递、经其 parent 中断它，以及分页读取 durable 事件日志。缺失的只是一层把 MCP 调用映射到这些服务的传输，而不为任务状态发明第二个事实来源。

## Decision

### 形态

一个可选插件 `@mochgolf/dsh-mcp-control`，设计为通过 patch overlay（`examples/cordis.yml`）加载进 DSH Web profile。它经 `ctx.effect(() => ctx.webServer.register(...))` 在共享的 `ctx.webServer` 上注册一条精确路由。没有 daemon、没有第二个 `createServer()`、没有私有 wire client，也没有 stdout scraping；路由跟随 Web 实例自身的 host 与 port，当该绑定不是 loopback 时加载失败。

插件注入 `webServer`、`sessionController`、`subagents`、`credentials` 与 `workspaceRegistry`。它不发布 `./invariant` 伴随包：它不持有任何可能被独立观察出分歧的持久化或内存投影，因此它转发的每种关系都已经在 DSH 拥有它们的地方可观察。

### 七个工具，没有任务状态

`session_start`、`session_send`、`session_cancel`、`agents_list`、`child_send`、`child_interrupt` 与 `events_read` 使用拥有相应效果的 Session Controller 与 subagent 方法。`child_send` 使用 `ctx.subagents.prompt` 并固定 `mode: continuable`，`child_interrupt` 使用 `interruptByParent`，因此 live direct parent 要求与 parent 授权校验留在已经实施它们的服务中。`agents_list` 原样转发原生 durable 条目（含 diagnostic），且从不重编号。`session_start` 接受的 `cwd` 与平台自身判定为绝对路径的取值完全一致，用的就是 Session header 校验 `cwd` 的同一个 `node:path` 谓词，因此 Windows 盘符根路径或 UNC 路径会被接受，而不是被 POSIX 前缀判断拒绝。它通过 `workspaceRegistry.resolveByPath` 查询现有的规范路径所有者，再把该工作区 id 交给 Session Controller；查询未命中或路径解析失败时仍走原来的 `cwd` 路径，而且不会创建工作区。它还在调用 `create` 之前自行选定会话 id，因为超过本次调用截止时间的 create 仍可能完成：否则客户端手里没有任何办法寻址该会话——接口没有枚举能力，重试还会再建一个。

每个回执报告的都是原生服务报告的内容。`accepted: true` 意味着 DSH 接收了工作；它绝不意味着某个轮次已结束、队列顺序得到承诺，或某个 child 已经存在。插件从不重试、从不保存 job、从不把 session 映射为 task，也从不创建 child——模型自己的 subagent 工具负责创建，端点只观察结果。

### 无损读取不新增工具

`events_read` 从调用方的 `after_seq` 向前分页，而这是唯一存在的游标：插件在请求之间不保留 listener、snapshot 或缓存，因此端点重启不会改变客户端续读的方式。每页以完整的 `CallToolResult` 字节预算为界，交付能够容纳的最大连续前缀，并停在读取开始时取得的水位。单个事件大到装不进一个结果时，以 `oversized_event` 连同字节长度与 SHA-256 报告，并用同一个工具的 `chunk` 模式取回；该模式绝不推进分页游标，客户端游标在重组出的字节通过校验后才移到 descriptor 的 `seq`，因为 `next_seq` 会有意停在调用方自身的位置。请求的 `max_bytes` 大于结果预算时，按该预算允许的最大分片返回：base64 与 JSON 在任何尺寸被测量之前就会分配数倍于切片的字节，因此预算必须约束读取本身，而不只是约束最终答案。除 SDK 自身的输入校验之外，工具 schema 还实施地址、游标与摘要规则。

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

包内测试让端点跑在真实 Agent Loop、Session Controller、subagent 运行时、JSONL 持久化与共享 WebServer 上，覆盖防护、凭据轮换、卸载与重载、Agent 运行中的重载、七个工具的成功与拒绝路径、游标语义、字节预算与分片重组。配置用例断言加载期的拒绝，包括 WebServer 永远匹配不到的路由路径、计时器永远无法调度的超时，以及任何请求都无法呈现的凭据；另有一个用例用平台谓词能够区分的各种拼写驱动 `session_start`，把该工具的判断在每个平台上都钉在 `node:path.isAbsolute` 上，还有一个用例证明超过截止时间的 create 仍会报告 DSH 实际收到的那个 id、且该会话确实落在该 id 下。分片大小上界既有直接断言，也有端到端断言：不受限的 `max_bytes` 返回的正是结果预算允许的那个分片。卸载针对「响应读到一半就不再读取」的客户端做了证明：写入触发背压，卸载仍能完成，共享监听器继续服务其它路由，全程运行的 Agent 未受影响。结果预算经 HTTP 在允许的最小预算下验证，覆盖多字节与大量转义字符的关联值、被切在代理对中间的诊断，以及比整个预算还长的未知参数名；README 公布的重组示例直接从该 README 中提取并对真实端点执行。随包发布的 Web profile 通过官方 MCP 客户端经 HTTP 做端到端验证，并新增录制会话快照（`snapshots/web/mcp-control/`），用真实 `dsh web` profile 驱动端点：根会话、由模型原生创建的 continuable child、向 child 投递、原始工具事件、重连后的游标续读，以及独立的 `workspace.expected/` 核验，全部以无密钥回放执行。重启用例证明已提交日志仍可读、冷 parent 被拒绝、parent 经原生方式恢复后 child 重新可控；真实模型用例覆盖文件写入任务、原生创建 child 与向 child 投递。
