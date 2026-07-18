# den-api/
> L2 | 父级: ../../../AGENTS.md

Den API 是 OpenWork Cloud 的组织级控制面；HTTP、OAuth、MCP 与外部能力连接都在此汇合，但执行策略仍由各子模块独立维护。

## 成员清单

- `src/`: 运行时代码；路由、身份、能力源和 MCP 适配层从这里装配。
- `test/`: Bun 回归与集成测试；验证租户隔离、连接生命周期和公共协议契约。
- `scripts/`: 构建、迁移和演示数据脚本；只承载运维入口，不承载产品规则。
- `evals/`: Den API 专属评测资产。
- `.env.example`: 本地与部署环境变量样例。
- `README.md`: 服务开发与运行说明。
- `package.json`: `@openwork-ee/den-api` 包边界、依赖与 pnpm 脚本。
- `start.md`: 服务启动手册。
- `tsconfig.json`: TypeScript 编译边界。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
