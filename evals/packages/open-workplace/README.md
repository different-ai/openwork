# Open Workplace

Self-hosted versions of the workplace apps a company runs, so agents can be tested end to end against something that looks and behaves like the real thing:

| App | What it is | Compatible with |
|---|---|---|
| **Open Outlook** | Mail: folders, threads, drafts, replies | Microsoft Graph `/v1.0/me/messages`, `/mailFolders` |
| **Open Calendar** | Events, attendees, rescheduling | Microsoft Graph `/v1.0/me/events` |
| **Open Drive** | Files and folders, Office documents, upload sessions | Microsoft Graph `/v1.0/me/drive` |
| **Open Jira** | Issues, JQL, an IT service desk | Jira Data Center REST v2, Jira Service Management |
| **Open Confluence** | Spaces and pages | Confluence Data Center REST |

Each app has a web UI and an MCP endpoint, so OpenWork connects to them like any other connector. The Jira and Confluence tools match the community [`mcp-atlassian`](https://github.com/sooperset/mcp-atlassian) server (same names and schemas). That server also works against Open Jira and Open Confluence unchanged.

Everything is seeded with the **Acme Robotics** sample organization: people, customers, mail, files, issues and pages. The raw services default to memory-only state; restarting restores the seed. The authenticated workshop gateway can instead retain each participant's data in private SQLite snapshots on a persistent disk.

## Multi-participant workshops

Use the authenticated [workshop gateway](WORKSHOP.md) for individual exercises. Opening it automatically creates/restores a private browser workspace—no password or account card. It provides private service processes, durable storage and explicit OAuth consent for MCP. Publishing the standalone entry points below does **not** provide participant isolation.

## Run

```bash
node src/microsoft365.mjs     # Open Outlook, Open Calendar, Open Drive  (PORT=3993)
node src/atlassian.mjs        # Open Jira, Open Confluence APIs + MCP    (PORT=3991)
ATLASSIAN_BASE_URL=http://127.0.0.1:3991 node src/atlassian-web.mjs   # Open Jira / Open Confluence web UI (PORT=3992)
```

No install step: the package uses Node built-ins only (stable Node.js 24.x, version 24.22.1 or newer within that major).

| Service | Web | MCP | REST |
|---|---|---|---|
| `microsoft365.mjs` | `/outlook`, `/calendar`, `/drive` | `/outlook/mcp`, `/calendar/mcp`, `/drive/mcp` (`/mcp` = all) | `/v1.0/...` (Bearer `open-workplace-token`) |
| `atlassian.mjs` | via `atlassian-web.mjs` at `/jira`, `/confluence` | `/jira/mcp`, `/confluence/mcp` (`/mcp` = both) | `/jira/rest/...`, `/confluence/rest/...` (any Bearer token) |

Every service also answers `GET /health`, `GET /state` (the current data, for verifying what an agent did) and `POST /reset`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, per service | Listen address |
| `OPEN_WORKPLACE_PERSON` | `Alex Chen\|alex\|CEO` | The signed-in person: `Display Name\|handle\|Title` |
| `OPEN_WORKPLACE_NOW` | wall clock | Fixed ISO time for reproducible runs (also makes IDs deterministic) |
| `OPEN_WORKPLACE_TIME_ZONE` | `America/Los_Angeles` | Jira/Confluence display time zone |
| `PUBLIC_URL` | `http://HOST:PORT` | Address used in links handed out by Open Outlook/Calendar/Drive (`webUrl`, `webLink`) |
| `UPLOAD_URL` | `http://HOST:<listening port>` | Address in Open Drive upload-session URLs; API clients must reach it, so it never follows `PUBLIC_URL` |
| `JIRA_PUBLIC_URL`, `CONFLUENCE_PUBLIC_URL` | `https://jira.acme.test`, `https://confluence.acme.test` | Address used in Jira/Confluence browse links |

**Real-looking addresses.** Set the public URLs to intranet-style hostnames under a reserved private domain (for example `http://office.acmerobotics.internal`) and point the browser at the local ports with a host mapping. In OpenWork evals: `chrome({ hostRules: "MAP office.acmerobotics.internal:80 127.0.0.1:<port>" })`. Never use a public domain: anything an agent fetches or uploads there would go to whoever owns it. Links in mail, files and answers then look exactly like they would at a real company.

## Tests

```bash
node --test src/*.test.mjs                                              # browser and Confluence checks
pnpm --dir ../.. exec vitest run --project pr packages/open-workplace   # API and MCP checks (from evals/)
```

`OPEN_WORKPLACE_ATLASSIAN_PARITY=1` additionally runs the real `mcp-atlassian` (via `uvx`) against Open Jira and Open Confluence.

## Standalone by design

This package imports nothing from the rest of the repository, so it can move to its own repository and be hosted on its own. OpenWork test worlds start the files as child processes, or upload them verbatim into a sandbox.

The MCP endpoints are unauthenticated. Run them only inside a private test environment, never with real company data.

`docs/` records the real Microsoft 365 and Atlassian screens the UIs follow.
