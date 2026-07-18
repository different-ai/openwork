# evals/
> L2 | 父级: ../AGENTS.md

OpenWork 的体验证明模块。这里把“用户会看到什么”固化为 voiceover，再由 flow 驱动真实应用并产出 fraimz；规格、执行与证据沿同一条数据流前进。

## 成员清单

AGENTS.md: 本模块的职责、成员与证据链地图。
README.md: eval runner、voiceover、fraimz 与本地/Daytona 执行约定的入口文档。
drivers/: 浏览器和桌面驱动适配层，隔离 CDP 等运行环境差异。
fixtures/: 可重复的测试输入与外部系统替身，避免证明依赖不稳定生产数据。
flows/: 可执行用户旅程；每个 flow 将批准的 narration 绑定到动作、断言和截图。
results/: fraimz 运行产物目录；保存报告和截图，不作为源码提交。
runner/: voiceover 解析、漂移检查、flow 调度和 fraimz 报告生成内核。
scripts/: eval 环境启动、清理与辅助自动化脚本。
support/: 多个 flow 共享的领域无关测试支撑模块。
voiceovers/: 已批准的用户叙事契约；编号段落与 flow frame 一一对应。
browser-extension-flows.md: 浏览器扩展能力的人工验收地图。
cloud-admin-to-member-assignment-flows.md: 云端管理员向成员分配能力的验收地图。
cloud-auth-flows.md: 云端登录、过期授权、退出与组织切换的验收地图。
cloud-marketplace-sync-flows.md: 云端 marketplace 插件同步的验收地图。
cloud-mcp-agent-flows.md: Agent 通过能力轨管理组织资源的验收地图。
cloud-org-membership-flows.md: 组织成员关系与权限变化的验收地图。
cloud-provider-sync-flows.md: 组织级模型供应商同步的验收地图。
cloud-signin-client-provisioning-funnel.md: 从网站登录到桌面能力生效的商业漏斗验收地图。
daytona-flows.md: Daytona 桌面沙箱中的端到端执行指南。
daytona-server-failure-recovery-flows.md: Daytona 服务故障与恢复的验收地图。
daytona-server-sync-report.md: Daytona 服务同步验证报告。
default-openwork-marketplace-onboarding-flow.md: 默认 marketplace 新手引导的验收地图。
den-marketplace-guided-onboarding-flow.md: Den marketplace 引导安装的验收地图。
desktop-org-mcp-demo.md: 桌面端组织 MCP 演示规格。
desktop-policy-extension-flows.md: 桌面扩展策略下发与恢复的验收地图。
environment-variable-flows.md: 环境变量创建、遮罩、应用与重启的验收地图。
extensions-marketplace-flows.md: 扩展运行时和 marketplace 安装体验的验收地图。
onboarding-welcome-flows.md: 首次启动与工作区解释的验收地图。
openable-items-flow.md: 会话内可打开产物与导航入口的验收地图。
org-mcp-agent-config-ux.md: 组织 MCP Agent 配置体验规格。
org-mcp-connections-ux.md: 组织 MCP 连接管理体验规格。
react-session-flows.md: React 会话主链路与流式交互验收地图。
reload-events-flow.md: 配置变更与 reload 事件的验收地图。
workspace-layout-state-flows.md: 工作区布局持久化与迁移的验收地图。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
