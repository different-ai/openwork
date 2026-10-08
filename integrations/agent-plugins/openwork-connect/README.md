# OpenWork Connect Agent Plugin

This directory is the portable OpenWork Connect package for the published
Agent Plugins 1.0.0 specification. Install or copy the complete directory
through an Agent Plugins-compatible client. The package installs:

- the remote OpenWork MCP endpoint;
- guidance for the `search_capabilities` and `execute_capability` workflow;
- listing metadata and icons for clients that read the `com.openai` extension;
- no credentials or client-specific authentication configuration.

The MCP client discovers OpenWork OAuth from the endpoint and opens the normal
browser sign-in flow. Access remains scoped to the selected organization and
the signed-in member's grants.

The `streamable-http` entry does not pin an MCP wire version. OpenWork Connect
negotiates the stateless MCP 2026-07-28 protocol with current clients and keeps
the existing MCP 2025-11-25 compatibility path for clients that have not yet
migrated. No session identifier, token, or protocol-specific header is stored
in this package.

Agent Plugins does not standardize registries or installation UX. Distribution
of this directory is therefore client-specific.

## Install in Codex

The repository marketplace at `.agents/plugins/marketplace.json` lists this
package as `openwork-connect@openwork`:

```sh
codex plugin marketplace add different-ai/openwork --sparse .agents/plugins --sparse integrations/agent-plugins/openwork-connect
codex plugin add openwork-connect@openwork
codex mcp login openwork
```

## Install in ChatGPT

ChatGPT installs plugins with MCP servers from a registered connection:

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button,
   then **Add custom MCP server**.
2. Enter `https://api.openworklabs.com/mcp/agent`, keep OAuth, and select
   **Create as a plugin**.
3. Sign in to OpenWork and pick your organization.

Workspace admins can then publish it to selected workspace roles: in ChatGPT
Plugins, select **Personal**, open the plugin's menu, and select **Publish**.
This full package stays out of the public plugin directory; the directory
listing is the separate [`openwork`](../openwork) package.
