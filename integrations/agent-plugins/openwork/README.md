# OpenWork plugin

This directory is the OpenWork package for the plugin directory that ChatGPT
and Codex share. It brings the skills an organization shares in OpenWork into
the conversation:

- `mcp.json` points at OpenWork's skills endpoint, which serves only
  `list_skills`, `get_skill`, `create_skill`, and `update_skill`;
- `skills/get-started` is the onboarding skill run after installation;
- `skills/team-skills` explains how to find, follow, save, and update skills;
- `plugin.json` carries the listing text, icons, and review test cases under
  `extensions.com.openai`.

The package holds no credentials. The client discovers OpenWork OAuth from the
endpoint, and access stays scoped to the selected organization and the
signed-in member's grants.

For the full OpenWork Connect experience, including shared MCP connections,
connected services, Workflows, and Apps, install the
[`openwork-connect`](../openwork-connect) package instead.

## Build the upload

Zip the directory contents so `plugin.json` sits at the archive root:

```sh
cd integrations/agent-plugins/openwork
zip -r -X ~/openwork-plugin.zip . -x '.*' -x '*/.*'
```

Add the demo recording URL to `review.demo_recording_url` once it exists.
Reviewer credentials go only in the OpenAI plugin portal, never in this
package.
