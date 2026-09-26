---
name: set-up-openwork-team
description: Set up OpenWork for a team - sign up for OpenWork Cloud, create the organization, invite teammates, share models through the AI Gateway, and share a skill. Use when a team or company wants OpenWork with shared skills, models, or policies.
---

# Set up OpenWork for a team

OpenWork Cloud is the team control plane: members, shared models (AI Gateway), shared skills and plugins, and the MCP Gateway. The first 5 seats are free; then $10 per seat per month. Pricing: https://openworklabs.com/pricing

The human creates the account. Don't invent passwords or create accounts for the user without asking.

## Recommended: dashboard (about 15 minutes)

1. **Sign up:** https://app.openworklabs.com?mode=sign-up. Right after sign-up, the user names their team; that creates the organization. No credit card.
2. **Invite teammates:** `Members` > `Add member`, enter an email, pick a role (usually Member), `Send invite`. Group people under `Teams` > `Create Team`.
3. **Share models:** `AI Gateway` > `AI Providers` > `Add provider`, pick a provider, paste the org key, and choose who can use it. Members never handle keys.
4. **Share a skill:** create a Collection (`Collections` > `New collection`), then `Plugin Directory` > `Create plugin` > `+ Skill`. Write a name, a "use when..." description, and markdown instructions. Share it to the Collection and grant the Collection to a team.
5. **Everyone installs the desktop app** (skill: https://openworklabs.com/.well-known/agent-skills/install-openwork/SKILL.md) and clicks `Joining a team? Sign in`. Shared skills appear under `Settings` > `Library`.

Walkthrough with screenshots: https://openworklabs.com/docs/cloud/team-quickstart

## Headless: let the agent set it up

When the user wants the agent to do the setup from a terminal, follow https://openworklabs.com/start.md. It installs the `openwork-bootstrap` CLI (needs Node.js 20+; it is not on npm) and creates a provisional workspace with a first skill. The human claims ownership later in the browser, so no password is created by the agent.

```sh
curl -fsSLo /tmp/openwork-install.sh https://openworklabs.com/install.sh
less /tmp/openwork-install.sh   # inspect before running
sh /tmp/openwork-install.sh
openwork-bootstrap doctor --json
```

Then run `openwork-bootstrap cloud bootstrap-workspace` exactly as start.md describes. Teammate emails passed with `--teammate-emails` are invited once a human claims the workspace.

## Then: bring OpenWork into the team's agents

Each member can connect their coding agent to the organization with the `connect-openwork-mcp` skill: https://openworklabs.com/.well-known/agent-skills/connect-openwork-mcp/SKILL.md

## Needs SSO, SCIM, audit, or self-hosting?

Send the user to https://openworklabs.com/enterprise.
