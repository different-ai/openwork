<!--
[INPUT]: 依赖 OpenWork 会话、OpenWork Cloud 能力轨、外部 MCP 连接、标准文件 Artifact 与人工问题/权限交互所构成的真实用户旅程
[OUTPUT]: 对外提供 agentic-outreach 的八帧批准 narration，作为实现、flow 与 fraimz 的唯一体验契约
[POS]: evals/voiceovers 中的 B2B Outreach 垂直切片规格，约束能力发现、实时证据、付费 enrichment、发送审批和跨会话交接
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
-->

# agentic-outreach — 从实时信号到销售交接，全程由 Agent 动态组装

Maya 是一家 B2B 软件公司的增长负责人。她使用组织已经连接的搜索、人员数据、联系方式和邮件服务；OpenWork 不复制这些供应商，而是把它们编排成一条可审计、可暂停、可替换的 Outreach 运行链。

1. Maya 用一句话告诉 OpenWork：找出五十家最近三十天正在招聘合规负责人的美国 Series B 安全公司，只为合格的 VP 以上联系人购买已验证邮箱，预算不超过二十五美元，而且未经批准绝不发送。

2. OpenWork 把目标整理成一份 Outreach Brief，并实时发现组织已经连接的 Exa、Apollo、FullEnrich 和 Instantly 能力；每个选择都展示准确的参数契约和安全属性，缺少连接时只给出对应的人类修复动作。

3. Agent 查询实时来源并生成 lead-ledger.csv；每条候选公司都带有来源链接、观察时间、原始信号、供应商和置信度，因此 Maya 可以追溯任何一条判断，而不是相信一张来历不明的名单。

4. Agent 去重并把候选标记为合格、不合格或待确认，同时解释原因；联系方式仍然为空，Maya 清楚地看到昂贵的数据购买没有发生在资格判断之前。

5. Agent 汇报合格联系人数量和最坏情况下的费用并等待决定；Maya 批准后，它才购买联系方式，并把验证状态、实际花费和失败原因写回同一份 Ledger。

6. Agent 根据每家公司真实发生的信号生成三步触达内容和 campaign.md，并在预览里展示证据引用、重复触达检查、抑制名单和退订保护。

7. Maya 查看最终收件人、预计发送量和风险检查，批准这一次启动；Agent 随后调用已连接的发送能力，并把供应商返回的序列标识写入运行账本。

8. Maya 在一个新会话里要求检查回复，OpenWork 从运行账本恢复上下文并实时查询发送服务；发现积极回复后，Agent 暂停后续触达并生成带完整证据链的销售交接任务。
