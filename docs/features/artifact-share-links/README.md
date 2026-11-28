# Artifact share links (`artifactShareLinks`)

- **Feature key:** `artifactShareLinks`
- **Deployments:** cloud and self-hosted, off by default
- **Author:** @benjaminshafii

## What people get

Anyone who can open an artifact can copy a browser link for teammates. The
artifact does not need to be published as a site. The link grants no permissions:
the visitor must sign in, belong to the organization, and already have access
through the artifact's Plugin. Tools run as the visitor using their own
connections, not the sender's.

## How the link works

The link opens Den web at `/artifact?id=<appId>&org=<organizationId>`. After
sign-in, Den web sends the visitor to the Den API's member artifact page at
`/mcp/agent/connections/<appId>?org=<organizationId>`. The page uses the session
cookie to mint an MCP token scoped to `org`, without changing the session's
active organization. The page loads the artifact in a sandboxed frame and
forwards its requests to the artifact's MCP server as the visitor.

## Turning it off

Copy link disappears for members who no longer have the feature. Existing links
to artifacts that were not made sites stop opening for those members. Artifacts
with `site: true` still open as before for people who have access. Public artifact
links are unchanged.

## Limits

- The signed-in page needs the session cookie to reach the Den API origin, such
  as when the web and API subdomains share a cookie. Without it the API cannot
  mint a token, even if Den web recognizes the visitor's session.
- A link identifies the artifact, not a saved revision or a snapshot of its data.

## Try it

1. Turn on `artifactShareLinks` for your organization in `/admin`.
2. Build an artifact without making it a site. Give a teammate viewer access
   through its Plugin.
3. Copy the link and have the teammate open it in a browser. They can sign in
   and see the artifact with their own data. A teammate without access is refused.
4. Turn the feature off and reopen the link. The non-site artifact no longer
   opens in the browser, but a `site: true` artifact still does.

## Screenshots

- [Share dialog with the organization link and copy confirmation](share-dialog-link.png)
- [Den web sign-in from the shared link](sign-in.png)
- [Sign-in prompt when opening the artifact address directly](api-sign-in.png)
- [Live artifact in the browser](artifact-in-browser.png)
- [No-access page for a signed-in member without a share](no-access.png)

## Code and tests

- `ee/apps/den-api/src/routes/org/mcp-app-catalog.ts`: signed-in share-link route.
- `ee/apps/den-api/src/mcp/app-site.ts` and `mcp/app-server.ts` in the same
  source directory: browser shell, organization-scoped mint, and artifact access.
- `ee/apps/den-api/test/api/mcp-app-share-link.api.test.ts`: link, permissions,
  feature-off behavior, browser shell, and organization-scoped token mint.
- `ee/apps/den-api/test/app-site-member.test.ts`: browser mint and error states.
