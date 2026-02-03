# OpenCode Server
Run tasks from a shared runtime
---
## Summarize
- Define a local OpenCode server that OpenWork can discover, connect to, and use for task execution across devices
---
## Define problem
- OpenWork needs a reliable way to run tasks without bundling a full CLI per device while keeping setup simple and transparent
---
## Set goals
- Enable a host machine to run tasks for multiple OpenWork clients with clear status, fast connect, and predictable behavior
- Keep setup minimal and align with least-privilege, mobile-first usage
---
## Exclude scope
- Building a hosted SaaS, multi-tenant cloud, or marketplace for remote agents
- Supporting non-OpenWork clients beyond a basic compatibility layer
---
## Describe personas
- Mobile user who wants to run tasks from a phone against a home or work machine
- Power user who wants a stable local runtime for repeated workflows
- Admin who needs simple setup and clear permission prompts
---
## Define requirements
- Functional: discover host on LAN, connect via pairing, run tasks, stream logs, and handle reconnects gracefully
- UX: show connection status, explain permissions, and expose a clear health panel with actionable errors
---
## Detail integration
- Lifecycle: start server on host, advertise via local discovery, accept pairing, and serve OpenCode APIs over a secured channel
- Host/client: host runs OpenCode runtime and permission gates while clients send tasks, receive progress, and read logs
---
## Set permissions
- Require explicit pairing approval, scoped runtime permissions, and per-task confirmation for sensitive tools
---
## Cover telemetry
- Optional local metrics for uptime, connection failures, and task success, stored on host and never uploaded by default
---
## Map flow
- Onboarding: guide install, start server, and generate pairing code
- Connect: discover host, enter code, and validate permissions summary
- Health: show server uptime, last task status, and recovery actions
---
## Note risks
- Network discovery inconsistencies across platforms and routers
- Trust confusion if pairing and permission prompts are unclear
---
## Ask questions
- Should remote access beyond LAN be supported in this phase, and if so, which transport is acceptable
---
## Measure success
- 90%+ successful first-time pairing on supported platforms with fewer than two manual retries
- Stable task execution with <1% disconnect-related failures over 7 days
---
## Plan rollout
- Phase 1: local discovery and pairing on desktop host with basic status UI
- Phase 2: mobile client support, health panel, and reconnect logic
- Phase 3: permission refinements, metrics, and troubleshooting guide
