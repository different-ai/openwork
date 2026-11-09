# Open an App as a site (`appSites`)

- **Feature key:** `appSites`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

An App's MCP URL can also be opened in a browser. Someone who can edit the
App, or their agent, passes `site: true` to `create_app` or `update_app`. A
browser that opens the App's URL then shows the App full page. MCP clients
keep using the same URL as before.

- **Signed-in URL** (`/mcp/agent/connections/<appId>`): the page uses the
  visitor's OpenWork session in that browser, then loads the App as that
  member, with the same Plugin access as any MCP client. Without a session it
  asks them to sign in. A tool that is not read-only runs only after the
  person confirms it, once per call.
- **Public URL** (`/mcp/public/apps/<appId>`, needs `publicApps`): the page
  opens for anyone, with no sign-in.

A site is optional. An App that was not made a site answers a browser exactly
as it did before, and nothing changes for MCP clients either way.

## How a request is told apart

Only a `GET` that asks for `text/html` and carries no `Authorization` header
gets the page. MCP clients send `POST`, or `GET` for an event stream, so they
never match.

## How the page works

The page is the same for every App and contains nothing about the App. Its
script is a small MCP client: it calls `tools/list`, `open_app` and
`resources/read` on the URL it was served from, then puts the App's HTML in a
sandboxed frame and answers the frame's MCP Apps requests. The frame has no
`allow-same-origin`, so the App's code cannot read the page's token or the
origin's cookies.

Before sign-in, a browser can learn only that an App id exists and was made a
site. Links an App opens need the person's confirmation.

## Limits

- The signed-in page needs the session cookie to reach the Den API origin.
  That holds where the cookie is shared across subdomains; elsewhere the page
  asks the visitor to sign in and cannot continue.
- The page loads the App for the session's active organization.

## Try it

1. Turn `appSites` on for your organization in `/admin`.
2. Ask an agent to build an App and make it a site.
3. Open the App's MCP URL in a browser where you are signed in to OpenWork.

## Code

- `ee/apps/den-api/src/mcp/app-site.ts`: which requests get the page, and the
  page itself.
- `ee/apps/den-api/src/mcp-apps.ts`: `loadMcpAppSite`, `requireSites`.
- Test: `ee/apps/den-api/test/api/app-sites.api.test.ts`.
