# capability-sources/
> L2 | 父级: ../../AGENTS.md

Den API 的外部能力边界。这里统一处理第三方 MCP、原生 OAuth Provider、Google/Microsoft 数据映射与 Telegram 入口；路由层依赖这些稳定接口，不直接持有凭证、协议或供应商分支。

## 成员清单

- `enterprise-mcp-client-adapter.ts`: 将共享 enterprise MCP client 接入 Den 的凭证持久化、诊断与工具调用边界。
- `enterprise-mcp-oauth-persistence.ts`: 在组织/成员作用域持久化 MCP OAuth 注册、授权事务与 token 健康状态。
- `external-mcp-auth-policy.ts`: 依据预设和插件声明解析 MCP 的强制认证类型与预注册 OAuth 要求。
- `external-mcp-client-runtime.ts`: 选择当前 enterprise MCP runtime，并保留旧授权事务的兼容收尾路径。
- `external-mcp-client.ts`: 旧版 MCP SDK 客户端实现；负责发现、OAuth、分页目录与受限工具执行。
- `external-mcp-connections.ts`: External MCP Connection、访问授权、插件绑定与 OAuth 账户的唯一数据库仓储。
- `external-mcp-diagnostics.ts`: 外部 MCP 生命周期诊断、脱敏网络证据和安全错误分类。
- `external-mcp-oauth-contract.ts`: 生成共享/旧版 OAuth callback 与客户端元数据 URL。
- `external-mcp-presets.ts`: 一键连接目录的供应商名称、官方 URL 与认证类型真相源。
- `external-mcp-resolve.ts`: 将名称、主机或 URL 查询解析为已知预设或经探测的 MCP 候选。
- `external-mcp-rollout.ts`: 决定成员可见 MCP Connections 能力的组织 rollout 策略。
- `external-mcp-tool-inspection.ts`: 捕获并诊断一次 MCP 工具调用的安全请求/响应线索。
- `generic-oauth.ts`: 原生 Provider 共用的 PKCE、state、端点解析与 token 获取协议。
- `gmail.ts`: Gmail draft MIME 组装、附件编码与返回 ID 解析。
- `google-workspace-api.ts`: Google Workspace API 响应映射、搜索/上传参数与引用文本处理。
- `install-links-rollout.ts`: 组织安装链接能力的 rollout 决策。
- `microsoft-graph.ts`: Microsoft Graph 邮件、日历、Drive 与 Teams 的领域映射和错误协议。
- `native-provider-connections.ts`: 把原生 OAuth Provider 与当前成员账户折叠成可用连接目录。
- `oauth-callback-page.ts`: 生成完成或失败后的安全 OAuth 浏览器回调页。
- `oauth-client-rotation.ts`: OAuth client 身份变化时撤销旧账户，阻止凭证跨 client 延续。
- `oauth-credentials.ts`: 原生 OAuth client 与成员 connected account 的数据库仓储和刷新入口。
- `oauth-tenant.ts`: 规范 Entra tenant 并解析 tenant-aware OAuth 端点。
- `provider-registry.ts`: Google/Microsoft 等原生 OAuth Provider、scope 与功能映射注册表。
- `telegram-api.ts`: Telegram Bot API 验证、webhook、分段发送与重试语义。
- `telegram-connection-switch.ts`: 在数据库切换与 webhook 副作用间维持可补偿的一致性。
- `telegram-dispatcher.ts`: 限并发领取 Telegram 更新并分派给 worker，区分可重试失败。
- `telegram-store.ts`: Telegram 连接、配对、更新队列与处理租约的数据库仓储。
- `telegram-webhook.ts`: webhook 限流、secret 校验、去重入队与配对消费边界。
- `telegram-worker.ts`: 解析 worker 访问目标、提交会话提示并收集 Agent 回复。
- `url-guard.ts`: 外部 MCP 出站 URL 的 DNS/地址 SSRF 防护与跨 Realm Response 规范化。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
