---
description: Create or continue an evidence-first B2B outreach run with paid-contact and launch approvals
argument-hint: <target, signal, volume, budget, exclusions, or run id>
---
<!--
[INPUT]: 依赖用户的自然语言目标与 agentic-outreach Skill
[OUTPUT]: 对外提供 /outreach 命令入口，用于创建或续跑一个受控 B2B 外联 Run
[POS]: agentic-outreach 的薄命令 Adapter，只传递意图，不复制核心工作流
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
-->

Load the `agentic-outreach` skill and follow it exactly.

User request: `$ARGUMENTS`

If the request names an existing run, resume from its ledger before calling any external mutation. Otherwise create a new Outreach Brief. Ask only for missing constraints that materially change spend, audience, compliance, or launch behavior.
