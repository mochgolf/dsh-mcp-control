# 从本机 MCP 客户端控制 DSH

[English](usage.md) | 中文

这个默认关闭的 overlay 在 DSH Web 实例自身的 loopback 监听器上提供 Model Context Protocol 服务，使同一台机器上的 MCP 客户端——Codex、另一个 agent、脚本——可以按 id 启动会话、向其发送消息、取消它、列出它的 subagent 树，并读取它的 durable 事件日志。

该端点只是 Session Controller 与 subagent 服务之上的薄转发层。它不启动第二个监听器、不启动 daemon、不保存任务数据库，也不注册任何模型可见的内容。

本仓库以 DSH `0.1.5-rc.2` 为兼容测试基线。当前发布版 DSH 的 resolver 尚不能加载这个外部包；下方命令适用于 DSH 完成这项最小接入之后。

## 启用

把下面这段 overlay 保存为本机上的一个文件——已安装的 `dsh` 不发布示例文件——再传给 Web profile，并通过环境变量把 bearer token 交给 DSH 进程：

```yaml
- insert:
    - id: mcp-control
      name: '@mochgolf/dsh-mcp-control'
      config:
        tokenRef: DSH_MCP_CONTROL_TOKEN
```

```sh
DSH_MCP_CONTROL_TOKEN=... dsh web --patch ./mcp-control.cordis.yml --host 127.0.0.1 --port 8931 --no-open
```

overlay 只携带凭据*引用*（`tokenRef: DSH_MCP_CONTROL_TOKEN`）；token 本身绝不进入 YAML。端口任选一个空闲值——8931 只是示例，端点始终跟随 Web 实例自身的端口。源码检出附带同一个 overlay：[`examples/cordis.yml`](../examples/cordis.yml)，因此也可以直接从仓库根目录传入该示例。

不带 `--patch` 启动即停用端点；从用户 patch 层中移除 overlay 也一样。两种情况下 Web 界面都不受影响。若要跨多次运行保持启用，把 overlay 的那一条 `insert` patch 合并进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（针对单个 profile）或 `$DSH_HOME/cordis.patch.yml`（针对本机所有 profile），不要覆盖已有文件。

## 配置客户端

通过 MCP 客户端自身的环境变量给它同一个 token：只在 DSH 中设置该变量并不会传递给已经在运行的客户端。

```toml
[mcp_servers.dsh]
url = "http://127.0.0.1:8931/mcp"
bearer_token_env_var = "DSH_MCP_CONTROL_TOKEN"
startup_timeout_sec = 10
tool_timeout_sec = 30
```

客户端会列出七个工具：`session_start`、`session_send`、`session_cancel`、`agents_list`、`child_send`、`child_interrupt` 与 `events_read`。它们的输入、结果、错误码以及 `events_read` 的分页／分片形式由[包 README](../README.zh.md)说明。

`accepted: true` 意味着 DSH 接收了工作，而不是某个轮次已经结束。`child_send` 要求该 child 的直接 parent 处于 live 状态；端点会拒绝冷 parent，而不是恢复它。

## 验证路径

第一次检查用于确认端点只提供这七个工具，并且会话确实落盘：

1. 客户端对 `http://127.0.0.1:8931/mcp` 完成 MCP 握手，`tools/list` 恰好返回上述七个工具。
2. 把客户端的真实项目目录作为 `cwd`，连同一条提示词调用 `session_start`；它会在轮次结束前立即返回 `session_id` 与 `accepted: true`。若该路径已有工作区，新会话会出现在其中，其他路径仍保持未分组。省略 `agent_preset` 才会使用部署默认值；若该会话必须只读检查真实项目，则设置 `permission_preset: "read-only"`。继续协调前检查回执中的 `cwd`、`workspace`、`agent_preset` 与 `permission_preset`。
3. 用返回的会话 id 与请求 id 运行 `examples/collect-turn.mjs`。它会自动跟随 `events_read` 的分页和分片，并返回最终答案，不把原始 reasoning 与工具轨迹复制进控制端客户端的上下文。
4. 让模型通过它自己的 subagent 工具创建一个 child，随后 `agents_list` 会显示该 child 及其 `parentId` 与 `depth`。
5. `child_send` 返回 `message_id`，child 自己的日志在该次投递之后显示这条消息及其回答。
6. 用同一个 `DSH_HOME` 重启 DSH 进程：`events_read` 仍返回已提交的事件，`agents_list` 仍列出该 child。

第 2、3 步不需要 API 密钥；其余步骤需要可用的模型路由。

## 安全

该 token 等同于对该 DSH 实例可按 id 寻址的每个会话的完整控制权——请像对待本机 shell 访问权一样对待它。端点拒绝任何不是来自 `127.0.0.1` 且不是 Web 实例自身端口、未携带当前凭据的请求，拒绝转发头与外部 origin，也从不回答 approval、ask-user 或 elicitation 请求。它不是为远程、多用户或反向代理暴露而设计的；请像保护 DSH 进程本身一样保护客户端一侧的环境。

## 限制

- 只能控制已知的会话 id：没有枚举、搜索、改名、删除、fork、模型切换或历史改写。
- 需要审批的任务仍会在 Web 界面等待人工应答。
- 冷的直接 parent 会阻塞 child 控制，直到通过其自身入口恢复。
- 仅分页 header 或完整 descendant 树本身超过配置的结果预算时，会以 `mcp-control/result-too-large` 拒绝；只有单个超大事件有分片模式。
- 游标落在大型日志深处时，一页会读取覆盖该游标的逻辑前缀，而不只是它返回的事件：在生成的 10 万事件日志上读取 99,000 之后的一页，耗时约 0.9 秒、堆内存约 224 MB。请从已持有的游标继续，而不是每次从 `-1` 重读。
- 停止 DSH 进程会停止正在运行的工作；重启读取的是会话日志已提交的内容。
