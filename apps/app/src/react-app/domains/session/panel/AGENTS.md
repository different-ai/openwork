# panel/
> L2 | 父级: ../../../../../AGENTS.md

会话侧栏模块统一管理 Artifact 与 Browser 标签页；持久化只保存可恢复的浏览器引用，Agent 产物由当前会话重新同步，避免跨会话泄漏。

## 成员清单

- `panel-tab-store.ts`: Zustand 标签页状态与持久化/重建策略。
- `side-panel.tsx`: Artifact/Browser 侧栏装配、标签交互和仅开发环境的证明动作注册。
- `use-side-panel-tabs.ts`: 侧栏标签增删选排的 React Adapter。
- `utils.ts`: Electron Browser WebContentsView 的边界、坐标与遮挡工具。
- `outreach-eval-seed.ts`: Agentic Outreach Fraimz 的确定性外部系统替身，生成含双账本、哈希审批、durable Outcome Loop 与商业控制台的真实工作区文件。
- `outreach-eval-seed.test.ts`: 验证八阶段产物、外部瀑布计划、双账本、完整性发送门、事件幂等和跨会话 cursor 的纯契约测试。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
