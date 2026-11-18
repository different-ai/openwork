# Open an artifact as a site (`appSites`)

> **Generally available:** `appSites` is retired; the enabled behavior is now standard. Permissions, organization settings and entitlements still apply. Any rollout, off-state or kill-switch instructions below describe the historical rollout; see [the retirement guide](../ga-rollout-retirement/README.md).

- **Feature key:** `appSites`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

An artifact's MCP URL can also be opened in a browser. Someone who can edit the
artifact, or their agent, passes `site: true` to `create_app` or `update_app`. A
browser that opens the artifact's URL then shows the artifact full page. MCP clients
keep using the same URL as before.

- **Signed-in URL** (`/mcp/agent/connections/<appId>`): the page uses the
  visitor's OpenWork session in that browser, then loads the artifact as that
  member, with the same Plugin access as any MCP client. Without a session it
  asks them to sign in. The artifact's tools run as that member, with no extra
  prompt.
- **Public URL** (`/mcp/public/apps/<appId>`, needs `publicApps`): the page
  opens for anyone, with no sign-in.

A site is optional. An artifact that was not made a site does not open as a page,
and nothing changes for MCP clients either way.

## How a request is told apart

Only a `GET` that asks for `text/html` and carries no `Authorization` header
gets the page. MCP clients send `POST`, or `GET` for an event stream, so they
never match.

## How the page works

The page is the same for every artifact and contains nothing about the artifact. Its
script is a small MCP client: it calls `tools/list`, `open_app` and
`resources/read` on the URL it was served from, then puts the artifact's HTML in a
sandboxed frame and answers the frame's MCP Apps requests. The frame has no
`allow-same-origin`, so the artifact's code cannot read the page's token or the
origin's cookies.

At the signed-in URL nobody has signed in when the page is requested, so the
artifact is not looked up: every artifact ID gets the same page, whether or not the artifact
exists or is a site. After sign-in the page marks its requests with
`x-openwork-app-site`, and the artifact's server answers "The artifact is not available." unless the artifact was made a site
and the feature is on. At the public URL the page is served only for an artifact that is public and a site.

An artifact can open web links (http and https only) in a new tab.

## Search engines

Artifact pages are for the people given the link. Every site page, and every
answer at a public artifact URL, is sent with `X-Robots-Tag: noindex, nofollow,
noarchive`, and the page carries the same `robots` meta tag, so search engines
do not list it, follow its links or keep a copy. The URLs are not disallowed
in `robots.txt`, because a crawler that cannot fetch a URL never sees
`noindex` and can still list the bare link.

## Limits

- The signed-in page needs the session cookie to reach the Den API origin.
  That holds where the cookie is shared across subdomains; elsewhere the page
  asks the visitor to sign in and cannot continue.
- The page loads the artifact for the session's active organization.

## Try it

1. Turn `appSites` on for your organization in `/admin`.
2. Ask an agent to build an artifact and make it a site.
3. Open the artifact's MCP URL in a browser where you are signed in to OpenWork.

## Code

- `ee/apps/den-api/src/mcp/app-site.ts`: which requests get the page, and the
  page itself.
- `ee/apps/den-api/src/mcp-apps.ts`: `loadMcpAppSite`, `requireSites`.
- Test: `ee/apps/den-api/test/api/app-sites.api.test.ts`.
