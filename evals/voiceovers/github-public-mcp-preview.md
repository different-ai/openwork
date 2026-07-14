# GitHub public MCP preview — Review discovered setup before importing

This flow uses the public Anthropic Slack plugin bundle at
`anthropics/knowledge-work-plugins@47caa757e4730eb8daf7d335470f692d4a68b59e:partner-built/slack`.
The commit pin makes the reviewed GitHub source immutable, and the flow requires
no GitHub token or private-repository access.

Expected outcome:

- OpenWork previews the public bundle and links the review to the exact commit.
- The Slack MCP is identified as OAuth with a pre-registered client, required
  client ID and client secret inputs, and provider-advertised OAuth scopes.
- Skills remain unselected until explicitly reviewed.
- The admin can review everyone, team, or individual assignment rules.
- No secret is entered, no provider authorization starts, and no import request
  is submitted.

Safety and determinism boundary:

- The fixture's GitHub contents are immutable, but the preview still depends on
  public GitHub availability and its unauthenticated rate limit.
- Slack's MCP and OAuth metadata are live publisher responses. The flow asserts
  the stable `search:read.public` scope and intentionally fails if that published
  contract changes.
- This is the strongest safe preview/review proof. It does not click **Import
  selected**, because a full Slack import would persist organization state and
  requires real OAuth application credentials to finish configuration.

1. An organization admin opens Connections, chooses a plugin bundle, and pastes a public GitHub tree URL pinned to an immutable commit. OpenWork asks for no GitHub token and exposes no credential fields before the admin requests a preview.

2. OpenWork inspects the public bundle and shows the exact repository path and commit under review. The Slack MCP is listed separately from the bundled skills, and skills remain unselected until the admin explicitly trusts them.

3. Slack's selected configuration review is built from the MCP declaration and live protocol metadata. OpenWork identifies OAuth, explains that a pre-registered client is required, lists the client ID and secret it can collect securely, and shows the provider-advertised permissions.

4. Before importing, the admin can assign the bundle to everyone, specific teams, or specific people. Required OAuth values are still blank, Import remains disabled, and the review ends without installing a secret or creating a connection.
