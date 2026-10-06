---
description: "DSH Web 监听器上的可选 MCP 控制端点：让本机 MCP 客户端（如 Codex）启动、引导、取消、列出并读取已知会话。"
kind: "package-reference"
---

# @mochgolf/dsh-mcp-control

[English](README.md) | 中文

## 概述

`dsh-mcp-control` 在 DSH Web 监听器上提供 Model Context Protocol 服务，使同一台机器上的 MCP 客户端可以按 id 驱动它已经知道的会话。这些工具用于创建或采用根会话、提交与取消其工作、报告会话当前在做什么以及某条提示词得到了什么结果、列出其 durable subagent 树、向 continuable child 投递消息，以及读取 durable 事件日志。每次调用都使用原生 Session Controller、subagent 运行时与 Workspace Registry：该端点不拥有任务状态、不启动第二个监听器、不注册任何面向模型的工具，也从不代替用户回答审批。部署方主动插入该插件，其 bearer token 等同于对该实例可寻址的每个会话的完整控制权。

本仓库以 DSH `0.2.0-rc.2` 为兼容测试基线。先将本包装入 Web profile，再应用下方 overlay；该版本可解析 profile 中的外部插件，无需修改 DSH runtime。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当本地工具——Codex、另一个 agent、脚本——需要控制一个已经在运行的 DSH Web 实例，而不是在它的浏览器界面里输入时，添加本包。给 profile 加上 overlay，通过环境变量把 bearer token 交给 DSH 进程，然后让客户端指向 `http://127.0.0.1:<port>/mcp`。

### 启用端点

仓库附带的 overlay [examples/cordis.yml](examples/cordis.yml) 把插件插入 Web profile。它只携带凭据*引用*；token 保留在 DSH 进程的环境中。

```sh
DSH_MCP_CONTROL_TOKEN=... dsh web --patch examples/cordis.yml --host 127.0.0.1 --port 8931 --no-open
```

移除 overlay（或不带它重启）即停用端点；两种情况下 Web 界面都不受影响。路由属于 Web 监听器，因此其他任何注册方都不得已经占用 `path`。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `/mcp` | 共享 WebServer 上的精确路由；必须是单个绝对路径段，且写法与 WebServer 匹配的规范 URL 拼写一致，不能是 `/`、`/api`，也不能带尾斜杠、query 或 fragment |
| `tokenRef` | 必填 | 每次请求解析一次的凭据引用；绝不存放 token 本身。超出 RFC 6750 Bearer `b64token` 字符集的值会导致插件激活失败 |
| `defaultMaxEvents` | `128` | 分页请求省略 `max_events` 时返回的事件数 |
| `maxEvents` | `512` | 单次分页请求可要求的最大 `max_events` |
| `maxRequestBytes` | `1048576` | 单个请求体实际接收字节数的上限 |
| `maxToolResultBytes` | `1048576` | 单个完整工具结果（含其 JSON 文本副本）的上限；最小 `4096` |
| `defaultChunkBytes` | `65536` | 省略 `max_bytes` 时单个分片返回的原始事件字节数 |
| `requestTimeoutMs` | `25000` | 单次 MCP 调用的上限，不含 DSH 已接收之后的工作；最大 `2147483647`，即 Node 可调度的最大延时 |
| `autoRegisterWorktrees` | `false` | 当 `session_start` 指向某个链接 git 工作树的根目录且其尚未登记时，把它登记为独立的工作区 |

只有当 WebServer 绑定 `127.0.0.1`、凭据解析出非空值、配置合法且没有其他精确路由占用 `path` 时，端点才会加载；其他情况一律让插件激活失败，而不是退化成匿名或半配置的端点。

### 请求防护

每个请求在任何 DSH 服务被触达之前完成检查：`Host` 必须指向 `127.0.0.1` 与监听器自身的端口，若带 `Origin` 则必须等于本端点 origin，跨站 fetch 元数据以及任何转发头（`Forwarded`、`X-Forwarded-*`、`X-Real-IP`）都会被拒绝，bearer token 与本次请求解析出的凭据比较。请求体上限按实际接收的字节数计量，因此伪造或缺失的 `Content-Length` 无法让更大的请求体绕过它。凭据每次请求都重新解析，因此轮换或移除凭据无需重启即可生效。

### 客户端配置

通过客户端自身的环境变量给它同一个 token——只在 DSH 中设置并不会传递给已经在运行的客户端。

```toml
[mcp_servers.dsh]
url = "http://127.0.0.1:8931/mcp"
bearer_token_env_var = "DSH_MCP_CONTROL_TOKEN"
startup_timeout_sec = 10
tool_timeout_sec = 30
```

让 `tool_timeout_sec` 大于端点的 `requestTimeoutMs`（默认 25 秒），这样慢调用会在客户端放弃之前得到答复——要么是结果，要么是明确的 `request-timeout`；并通过 `bearer_token_env_var` 传递 token，不要把它作为明文 `Authorization` 头写进客户端配置文件。

### 工具

每个工具结果都同时以 `structuredContent` 和 `JSON.stringify` 文本块表达同一对象；工具级失败设置 `isError` 并返回 `{ error: { code, message, details } }`。`accepted: true` 意味着 DSH 接收了工作，绝不意味着某个轮次已经结束：cancel 与 interrupt 的回执报告的是接收，未领取的 inbox 条目与 descendant 保持不变。

| 工具 | 输入 | 结果 |
|---|---|---|
| `session_start` | `cwd`、`prompt`；可选 `agent_preset`、`permission_preset`、`session_id`、`request_id` | `session_id`、`request_id`、`accepted`、解析后的 `cwd`、`workspace`、`agent_preset`、`permission_preset`、`git_worktree`、`warnings` |
| `session_send` | `session_id`、`message`；可选 `delivery`（`queue` 或 `steer`）、`request_id` | `session_id`、`request_id`、`accepted` |
| `session_cancel` | `session_id`；可选 `clear_queue` | `session_id`、原生 `accepted`；清空时附 `removed_queue_items` |
| `turn_result` | `address`、`request_id`；可选 `wait_ms` | `state`、`agent_status`、`turn`、`reason`、`final_message`、`diagnostics`、`pending_approvals`，见下文 |
| `session_status` | `address`，格式同 `events_read` | 地址 id、`agent_status`、`head_seq`、最新 `turn`、等待中的 `queue`、`pending_approvals` |
| `agents_list` | `root_session_id` | `root_session_id`、带 `parentId` 与 `depth` 的原生 durable `entries` |
| `child_send` | `parent_session_id`、`child_session_id`、`message`；可选 `delivery`、`request_id` | 两个 id、`request_id`、`message_id`、`accepted` |
| `child_interrupt` | `parent_session_id`、`child_session_id` | 两个 id、原生 `accepted` |
| `events_read` | 下文的分页或分片请求 | 下文的分页或分片结果 |

`session_start` 要求把 MCP 客户端的真实项目目录作为 `cwd`：该值决定 DSH 项目上下文与工作区归组；临时目录只会产生未分组的临时上下文，并不能实施只读限制。`cwd` 必须是指向已存在目录的完全限定路径——Windows 上须为带盘符或 UNC 的路径，不能是 `\repo`、`/home/me/repo` 这类会按 DSH 进程当前盘符解析的根相对路径。目录在调用 DSH 之前完成检查，因为会话创建会把缺失的目录直接建出来并在其中开始工作：不存在的路径以 `mcp-control/cwd-not-found` 拒绝，文件以 `mcp-control/cwd-not-directory` 拒绝，两者都带 `stage: "cwd"`。它在创建前用现有 Workspace Registry 解析 `cwd`。规范路径完全匹配时，会话会挂载到该工作区；目录未登记或当前不可解析时，会话保持未分组；除非启用 `autoRegisterWorktrees`，端点不会创建工作区。链接 git 工作树——Codex 工作树任务所在的目录——与其主检出是不同的目录，而工作区成员关系要求路径完全一致，因此其会话保持未分组，而不会被挪进主检出的工作区：那样主检出的路径会取代 `cwd`，工作也会落进主检出。回执中的 `git_worktree` 给出工作树 `root`、`main_path`、`branch`（游离 HEAD 时为 `null`），以及为该主检出登记的 `main_workspace`。设置 `autoRegisterWorktrees: true` 时，工作树根目录本身会被登记为标题为 `<仓库> · <分支>` 的工作区，会话挂载其下；子目录永远不会被登记，工作树删除后该工作区仍会保留。当实际 preset 为 `workspace-write`、而仓库元数据位于 `cwd` 之外时（每个链接工作树以及检出的任意子目录都是如此），`warnings` 会带上 `git-metadata-outside-cwd`：会话可以在其中修改文件，但写入仓库的 git 命令很可能被拒绝，因此应由拥有该工作树的客户端提交。省略 `agent_preset` 才会使用部署默认值；只在有意覆盖且已知名称时传入。需要明确权限时，把工具 schema 公布的原生名称传给 `permission_preset`；例如 `read-only` 会限制访问，同时保留真实项目 `cwd`。该 preset 在创建前完成校验，并在首条提示词之前应用。回执报告解析后的 `cwd`、已挂载的 `workspace`（否则为 `null`）、实际 `agent_preset`（否则为 `null`）与实际 `permission_preset`，调用者可立即发现上下文错误。当传入的 `session_id` 已存在于该目录时，`session_start` 采用该会话；与既有会话冲突时拒绝。会话 id 由插件在调用 DSH 之前自行选定，因此即使 create 超过了本次调用的截止时间，失败结果仍会在 `details.session_id` 与 `stage: "create"` 中报告该 id：该会话可能已经存在，复用报告出的 id 会采用它，而不是再建一个。未提供 `session_id` 但提供了 `request_id` 时，会话 id 由该 `request_id`、规范化后的 `cwd` 与提示词派生，因此首次回执没有送达的重试——客户端自己的工具超时触发了，或用户中断了调用——会采用首次尝试已创建的会话，且不会重复提交提示词；每次新建都应传入新的 UUID，重试时原样复用。两者都不提供时，仍随机生成 id。`stage: "permission"` 失败表示会话已经创建，但提示词尚未提交。提供 `request_id` 会把重试关联到首次尝试已持久化的那条消息，但它只是关联，不是 exactly-once 保证：插件自身从不重试。

`session_status` 在不激活会话的前提下报告它当前在做什么：`agent_status`（`running`、`idle` 或 `not_loaded`）、最新 `turn` 及其是否仍未结束、持久化收件箱中每条仍在等待的提示词及其 `request_id`（与日志取自同一次观察，因此即使没有已加载的 Agent 也会报告），以及未结束轮次正在等待的 `pending_approvals`（最多 20 条，其余数量由 `pending_approvals_omitted` 给出）。它能区分只读日志的调用者分辨不出的三种状态：轮次仍在计算、轮次被只有人类才能在 Web UI 中作出的决定阻塞、提示词滞留在收件箱中。滞留的提示词不会自行开始：`session_cancel` 默认保留等待中的提示词，而之后任何一条提示词唤醒 Agent 时它们就会立即执行，因此需要传入 `clear_queue: true`，在中断之前通过控制器自身的队列修改把它们移除。中断与移除都需要 Agent 已加载：对于 Agent 未加载的会话，`session_cancel` 会返回 `session/not-found`（并用 `removed_queue_items` 与 `removed_queue_item_count` 列出已经移除的条目），而为它排队的提示词会在之后某条提示词激活该会话时执行。

`agents_list` 原样转发原生条目（包括 diagnostic 条目）。DSH 0.1.7-rc.2 的原生树沿持久化的父级 catalog 遍历，未记录于其中的会话不会列出；其中的 `activity: running` 表示会话记录常驻，而非模型正在计算，也不是完成状态。

### 读取 durable 事件

分页请求从 `after_seq`（默认 `-1`，即第一条事件）向前读取，最多 `max_events` 条事件：

```json
{"address":{"kind":"session","session_id":"S"},"after_seq":-1,"max_events":128}
```

地址要么是 `{"kind":"session","session_id":"S"}`，要么是 `{"kind":"subagent","parent_session_id":"A","child_session_id":"A2","mode":"continuable"}`；subagent 形式走 controller 自身的 parent 与 mode 校验。结果携带 `header`、读取开始时的水位 `head_seq`、指向最后一条实际交付事件的 `next_seq`、`has_more`，以及 DSH 原样暴露的事件——包括工具结果、metadata、`sourceEventSeqs` 与 `ignorable` 标记。越过水位的游标以 `mcp-control/cursor-ahead` 拒绝，而不是回绕。读取不会激活冷会话，也不在请求之间保留 listener、cursor 或缓存：`after_seq` 是唯一存在的游标，因此重启端点不会改变客户端续读的方式。

`max_events` 限制的是分页返回的事件数，而不是 Session Controller 为定位它们读取的字节数：原生历史 API 以 message 对齐，因此游标落在大型日志深处时，一次调用会读取覆盖该游标的逻辑前缀。在生成的 10 万事件日志上，读取 99,000 之后的一页耗时约 0.9 秒、只发起一次原生 `page` 调用，期间堆内存约 224 MB。请从已持有的游标继续向前分页，而不是每次从 `-1` 重读；`requestTimeoutMs` 要按日志规模而非事件条数设置。

无法完整交付的事件会被报告而不是截断：

```json
{"mode":"page","head_seq":57,"next_seq":41,"has_more":true,"events":[],"oversized_event":{"seq":42,"byte_length":931842,"sha256":"…"}}
```

客户端用同一个工具的分片模式取回它：拼接 base64 分片、核对总长度与 SHA-256，再把合并后的字节按 UTF-8 JSON 解析：

```json
{"mode":"chunk","address":{"kind":"session","session_id":"S"},"event_seq":42,"offset":0,"max_bytes":65536,"sha256":"…"}
```

`next_seq` 绝不会越过没有完整交付的事件，分片结果也绝不推进分页游标。因此返回 `oversized_event` 的分页会把 `next_seq` 留在调用方自己的 `after_seq` 上；只有当重组出的字节通过校验后，客户端游标才推进到 descriptor 的 `seq`。请求的 `max_bytes` 若大于结果预算，会按该预算允许的最大分片返回，而不会成为编码超过结果可承载范围的理由。摘要不符以 `mcp-control/event-changed` 拒绝；客户端重新读取分页以获得新的 descriptor。

### 获取轮次结果

`turn_result` 回答协调端真正关心的问题——它发出的提示词得到了什么结果——而原始日志不会进入它的上下文。传入 `address`（格式同 `events_read`）以及 `session_start`、`session_send` 或 `child_send` 返回的 `request_id`：

```json
{"address":{"kind":"session","session_id":"S"},"request_id":"R","wait_ms":20000}
```

结果用 `state` 说明该提示词所处的状态：

| `state` | 含义 |
|---|---|
| `ended` | 轮次已结束：`reason` 是原生结束原因（`completed`、`aborted`、`error`、`interrupted` 等），`final_message` 是最后一条 assistant 文本或 `null`，`diagnostics` 是该轮次的工具失败 |
| `running` | 轮次仍在计算，或刚刚领取了该提示词；请再次调用 |
| `queued` | 提示词仍在收件箱中等待；若 `agent_status` 为 `"idle"`，它已滞留，只有其他提示词唤醒 Agent 时才会开始 |
| `blocked_on_approval` | `pending_approvals` 列出需要人类在 Web UI 中作出的决定，之后轮次才能继续 |
| `discarded` | 提示词进入过收件箱，但没有任何轮次执行它——被带 `clear_queue` 的 `session_cancel` 移除，或在 Agent 关闭时被取消（关闭会取消所有仍在等待的提示词），或被某个轮次领取后又被其 `agent/pre-step` 监听器改写掉 |
| `not_found` | 日志与持久化收件箱中都没有该 `request_id` |

单次调用最多等待 `wait_ms`（默认 20000；`0` 立即作答），且上限低于 `requestTimeoutMs`，保证调用在自身截止时间之前作答；轮次一旦结束或被阻塞就立即返回，滞留的提示词会在不到一秒内报告，而不会等满整个时长。它由会话自身的事件唤醒，在调用之间不保存任何东西，也从不激活冷会话。原始 reasoning、工具轨迹与无关事件都不会出现；超出结果预算的最终消息会在码点边界截短并带上 `final_message_truncated: true`，`final_message_seq` 指出可由 `events_read` 完整读取的事件。由于它走客户端已持有的 MCP 连接，沙箱中的 agent 无需 shell 访问、网络权限，也无需在命令环境里提供 token。

### 失败码

原生失败保留其 DSH code、message 与公开 details。端点新增 `mcp-control/cwd-not-found`、`mcp-control/cwd-not-directory`、`mcp-control/cwd-unavailable`、`mcp-control/cursor-ahead`、`mcp-control/event-changed`、`mcp-control/result-too-large`、`mcp-control/request-timeout`、`mcp-control/invalid-offset`，以及用于没有公开映射的异常的 `mcp-control/internal`。若某次调用的截止时间在 DSH 可能已经接收工作之后才到期，它会报告 `receipt: unknown`，而不是给出错误的拒绝。每个结果都按完整的 UTF-8 JSON 计量，text 兜底与 `structuredContent` 一并计入：装不下的失败载荷会退化为 `result-too-large`，保留预算容得下的关联字段，并用 `details.omitted` 列出被丢弃的字段；被拒绝的参数对象也会在同一预算内作答，即使违规字段名本身长于预算——被缩短的诊断会说明它替换掉了多少字节。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明端点背后的设计，并指向实现它的代码；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计

- **端点不拥有状态。** 会话、subagent 关系、inbox 与事件日志属于 Session Controller、subagent 运行时与会话持久化。插件只持有一个路由注册、MCP SDK handler，以及干净卸载所需的请求生命周期句柄。
- **单一监听器。** 路由通过 `ctx.effect(() => ctx.webServer.register(...))` 注册到共享的 `ctx.webServer`；不存在第二个 `createServer()`、没有 daemon，也没有私有 wire client。
- **原生权威做决定。** `child_send` 经 `ctx.subagents.prompt` 并使用 `mode: continuable`，`child_interrupt` 经 `interruptByParent`，因此 live direct parent 要求与寻址校验留在 DSH 已经实施它们的地方。端点从不恢复 parent、从不列出它无法寻址的对象，也不重编号原生条目。
- **卸载会结束本插件的请求。** 释放时注销路由、中止插件自身的 signal、结束仍在进行中的每个请求——正在接收的请求体，以及 SDK 仍在向停止读取的客户端写入的响应，都会因此结算——然后等待这些请求并关闭 SDK handler。结束请求只会断开它的连接；它不撤销 DSH 已经接收的工作，也不关闭共享 WebServer、不 dispose Session Controller，也不停止任何 Agent。

### 源文件地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：路由注册、卸载生命周期、请求接收 |
| [`src/config.ts`](src/config.ts) | 部署配置 schema 与跨字段校验 |
| [`src/http.ts`](src/http.ts) | 权威、origin、bearer token 与有界请求体检查 |
| [`src/tools.ts`](src/tools.ts) | 工具注册；start、send、cancel 与 subagent 工具及其原生服务调用 |
| [`src/paths.ts`](src/paths.ts) | 完全限定 `cwd` 规则，以及会话创建前的存在性检查 |
| [`src/log.ts`](src/log.ts) | 读取类工具共享的地址 schema、不激活会话的开场观察与向后尾部读取 |
| [`src/status.ts`](src/status.ts) | `session_status`，以及轮次、收件箱与审批的折叠 |
| [`src/events.ts`](src/events.ts) | `events_read` 分页、字节预算与分片重组 |
| [`src/result.ts`](src/result.ts) | 结果、失败与单次调用截止时间处理 |
| [`src/turn-result.ts`](src/turn-result.ts) | `turn_result`：定位提示词所在轮次、有界的事件驱动等待与紧凑结果 |
| — | 不发布运行时 invariant 伴随包：该插件不保存任何自己的持久化或内存投影，因此它转发的每种关系都已经可以通过它调用的 Session Controller、subagent 运行时与会话持久化观察到。 |

### 请求生命周期

路由处理器按顺序接收请求——权威与 origin、为本次请求解析的凭据、有界请求体——之后才把它交给 MCP SDK。接收阶段属于插件的 in-flight 集合；卸载会中止自身 signal、结束每个 in-flight 请求的 socket，然后才等待该集合排空并关闭 SDK handler，因此即使客户端停止读取，也没有请求能比端点存活更久。因此插件重载就是 MCP 的重启边界：客户端重连并从自己的 `after_seq` 续读，而整个进程退出只留下会话日志已经提交的内容。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够时阅读这些页面。它们从端点走向它所调用的服务，以及启用它的指南。

- [用户指南](docs/usage.zh.md) — 启用 overlay、客户端配置与最短验证路径。
- [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.zh.md) — 每个根工具映射到的 create、prompt、cancel 与 history 操作。
- [Subagent 运行时](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/README.zh.md) — child 工具背后的 descendant 列举、continuable prompt 与 parent 授权的 interrupt。
- [WebServer](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.zh.md) — 本端点所服务的精确路由注册与共享监听器。
- [Credentials](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials/README.zh.md) — bearer token 背后的 `credentialRef()` 与每请求 `resolve()`。
- [防御模式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/defensive-patterns.zh.md) — 本端点遵循的请求生命周期与 teardown 规则。

-----

<a id="model-experience"></a>
## 模型体验

无。该端点不在 `ctx.tools` 上注册任何内容，也不向任何模型请求贡献提示词、工具 schema 或消息；它由本机 MCP 客户端触达，而不是由模型触达。

#### KV Cache 影响

无；该插件既不组装也不发送 provider 请求，因此不可能改变已缓存的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该端点刻意不能做什么，以及何时需要运维上的注意。它们是当前的包约束，不是任务清单。

- **bearer token 等于该实例的完整控制权** —— 该 DSH 实例能够按 id 寻址的每个会话都可触达；没有按 token 的会话 ACL、没有 cwd 白名单，也不支持远程、多用户或反向代理部署。请像保护 DSH 进程本身一样保护客户端一侧的环境。
- **只能控制已知 id** —— 没有会话枚举、搜索、改名、删除、fork、模型切换、队列编辑或历史改写；客户端必须已经持有它想操作的 id。
- **审批仍留在 Web 界面** —— 端点从不回答 approval、ask-user 或 elicitation 请求，因此需要人工应答的任务会等待人类，并不是无人值守的。
- **冷的直接 parent 会阻塞 child 控制** —— `child_send` 以 `subagent/parent-unavailable` 拒绝，而不是恢复 parent；通过其自身入口恢复 parent 是调用方的步骤。
- **装不下的结果被拒绝，而不是分页** —— 超过结果预算的单个事件可通过分片模式取回，但仅分页 header 或 `agents_list` 树本身超过预算时返回 `mcp-control/result-too-large`；该树没有分页模式。
- **工作树会话默认不分组** —— 工作区成员关系是路径完全匹配，因此链接工作树的会话永远不会加入其主检出的工作区；`autoRegisterWorktrees` 改为给每个工作树根目录建立独立的工作区，而工作树删除时这些工作区不会随之移除。
- **进程退出会停止计算** —— 持久性属于会话日志；重启读取的是已提交的内容，运行中的工作不会被端点恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
