# desktop-policies-cloud-mcp — Admins edit desktop policies straight from the agent, through OpenWork Cloud

Cast: Alex (org super-admin) and Jordan (ordinary member), both in the Acme
Robotics demo org against a real local Den stack. Frames 1–3 drive the real
OpenWork Cloud MCP rail (`/mcp/agent`, `search_capabilities` +
`execute_capability`) with Alex's real org-scoped MCP token. Frames 4–5 prove
the write landed on both real surfaces — the Den web dashboard and the member
desktop app. Frame 6 proves the permission boundary with Jordan's token.

1. I'm an org admin and I don't open a dashboard — I ask through OpenWork Cloud, and capability search comes back with the desktop policy tools.

2. I execute the read capability and see my organization's policies as data: the default policy, and custom providers currently allowed.

3. I execute the update capability to switch custom providers off — it lands on the same guarded route the dashboard uses, so super-admin and plan checks still apply.

4. The cloud dashboard agrees: the Desktop Policies page now shows custom providers restricted, without me ever touching it.

5. A member's OpenWork picks up the new config on its own, and custom providers are now locked on their desktop.

6. When an ordinary member tries the same write, it's refused — the capability carries your role and nothing more.
