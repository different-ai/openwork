# mcp/
> L2 | 父级: ../../AGENTS.md

该模块把 Den 原生 API、平台管理能力、已连接外部 MCP、市场插件与 Skills 折叠到稳定的 MCP 接口；发现与执行分离，租户授权和真实执行路径不在适配层复制。

## 成员清单

- `README.md`: Den API MCP 暴露策略与阻断边界。
- `admin-capabilities.ts`: 将允许的平台管理操作适配为可搜索、可执行的命名空间能力。
- `admin-tools.ts`: 管理工具的具体注册与协议形状。
- `admin.ts`: 管理 MCP 路由装配。
- `agent.ts`: 面向 Agent 的两工具门面，只暴露能力搜索与通用执行。
- `auth.ts`: MCP 请求身份解析与资源上下文校验。
- `catalog.ts`: 从 OpenAPI 构造原生能力目录与参数契约。
- `connection-navigation.ts`: 生成连接修复所需的精确产品入口。
- `external-capabilities.ts`: 外部 MCP 的成员级发现、健康状态和执行 Adapter。
- `index.ts`: 富 MCP 端点与目录注册入口。
- `invoke.ts`: 原生 Den API 能力的统一调用路径和输入归一化。
- `json-rpc-preflight.ts`: JSON-RPC 请求进入 MCP SDK 前的协议预检。
- `jwt-policy.ts`: MCP JWT 签发与验证策略。
- `marketplace-capabilities.ts`: 市场插件对象的能力搜索与执行 Adapter。
- `oauth-client-policy.ts`: MCP OAuth 客户端注册与重定向策略。
- `plugin-mcp-requirement-bindings.ts`: 插件声明到组织 MCP 连接要求的绑定逻辑。
- `policy.ts`: OpenAPI 操作进入 MCP 目录的允许与阻断策略。
- `resource.ts`: MCP 受保护资源元数据与发现端点。
- `scopes.ts`: MCP OAuth scope 解析和授权边界。
- `search.ts`: 各能力源共享的候选模型、评分和原生目录搜索。
- `skill-capabilities.ts`: 原生及市场 Skill 的搜索与读取 Adapter。
- `token-lifetime.ts`: MCP 访问令牌生命周期策略。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
