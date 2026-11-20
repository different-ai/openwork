# OpenWork Connect Agent Plugin

This directory is the portable OpenWork Connect package for the published
Agent Plugins 1.0.0 specification. Install or copy the complete directory
through an Agent Plugins-compatible client. The package installs:

- the remote OpenWork MCP endpoint;
- guidance for the `search_capabilities` and `execute_capability` workflow;
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
