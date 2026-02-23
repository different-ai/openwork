# OpenWork Principles

## Decision framework for adding new features or fixing bugs:

- is it easy to test? how can we make it more easy ? (e.g. we can use the chrome mcp  and pnpm:dev to test ui take screenshots)
- is there an existing opencode equivalent for this feature? (we should use it if we can) if not how does it map to a better user experience for bob *or* susan (see below)
- if it's a bug what were you testing? what were you trying to achieve? what did you observe we can't move on before having a core undesrtanding

## Constraints

- Work with **only the folders the user authorizes**.
- Treat **plugins + skills + commands + mcp** as the primary extensibility system. These are native to OpenCode and OpenWork must be a thin layer on top of them. They're mostly fs based.

## Principles

- **Parity**: UI actions map to OpenCode server APIs.
- **Server-consumption first**: OpenWork app consumes OpenWork server surfaces (desktop-hosted, orchestrator-hosted, or cloud-hosted) instead of inventing parallel behavior.
- **Transparency**: plans, steps, tool calls, permissions are visible.
- **Least privilege**: only user-authorized folders + explicit approvals.
- **Prompt is the workflow**: product logic lives in prompts, rules, and skills.
- **Graceful degradation**: if access is missing, guide the user.
- **Progressive disclosure by default**: non-technical users should see clear primary actions first; IDs/URLs/diagnostics stay behind explicit "manual" or "advanced" sections.
- **Cloud + self-hosted consistency**: the same connect mental model (`Add worker` -> `Connect remote`) should work regardless of where the server runs.

## Security & Privacy

- Local-first by default.
- No secrets in git.
- Use OS keychain for credentials.
- Clear, explicit permissions.
- Exportable audit logs.
