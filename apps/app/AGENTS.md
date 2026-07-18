# app/
> L2 | 父级: ../../AGENTS.md

OpenWork 桌面应用把工作区、会话、扩展与 Agent 产物组织成用户控制面；业务能力来自 server/OpenCode/MCP，React 层负责可见交互和证明入口。

## 成员清单

- `src/`: Electron 与 React 应用源代码。
- `tests/`: 跨进程和桌面行为测试。
- `scripts/`: 应用构建、扩展清单与测试辅助脚本。
- `public/`: 静态视觉资源。
- `electron/`: Electron 主进程与 preload 边界。
- `package.json`: `@openwork/app` 包依赖和 pnpm 脚本。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
