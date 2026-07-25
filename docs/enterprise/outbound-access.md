# Outbound network access for OpenWork

This page lists what OpenWork may need to reach from locked-down networks. The machine-readable source is [`outbound-access.json`](./outbound-access.json).

## Minimum allowlist for the hosted desktop

For a practical hosted OpenWork desktop install, allow TCP 443 to:

```text
app.openworklabs.com:443
api.openworklabs.com:443
github.com:443
release-assets.githubusercontent.com:443
objects.githubusercontent.com:443
registry.npmjs.org:443
models.openworklabs.com:443
```

Commonly missed entries:

- GitHub release-asset downloads redirect away from `github.com` to a separate download host. If only `github.com` is allowed, the OpenWork installer/updater can start and then fail during the download. Allow both `release-assets.githubusercontent.com` (the host GitHub uses today, verified against a real OpenWork release asset) and `objects.githubusercontent.com` (the earlier host, kept for older clients and any staged rollback).
- `registry.npmjs.org` is used by `npx -y openwork-ui-mcp` in packaged desktop builds. If it is blocked, the UI-control MCP is unavailable even though the desktop app still opens.

## Desktop client outbound access

### Core hosted desktop

| Host | Required or optional | Purpose | What breaks when blocked |
| --- | --- | --- | --- |
| `app.openworklabs.com` | Required for OpenWork Cloud | Hosted Cloud web origin. The desktop uses one base URL and derives Den API/MCP calls as `<baseUrl>/api/den/...`. | Cloud sign-in, org settings, marketplace, and remote workspace flows cannot load. |
| `api.openworklabs.com` | Required for hosted install/OpenWork Connect | Hosted public API and OpenWork Connect MCP endpoint used by installer and external-client flows. | Hosted install checks or public OpenWork Connect fail. |
| `github.com` | Required in practice | Installer/updater release URLs and GitHub links. | Install/update downloads cannot start. |
| `release-assets.githubusercontent.com` | Required in practice | GitHub release-asset redirect target used today. | Downloads start from `github.com` and fail partway through. |
| `objects.githubusercontent.com` | Required in practice | Earlier GitHub release-asset redirect target, allowed for older clients and staged rollback. | Downloads can fail partway through if GitHub serves this host. |
| `registry.npmjs.org` | Required in practice | `npx` package resolution for `openwork-ui-mcp`. | UI-control MCP is unavailable. |
| `models.openworklabs.com` | Required in practice | First-party model catalog mirror, overridable with `OPENCODE_MODELS_URL`. | Model catalog is unavailable or degraded. |

Self-hosted Den replaces `app.openworklabs.com` and `api.openworklabs.com` with your own origin. Current desktop clients need only one Den origin; API and MCP requests are derived from that base URL as `<baseUrl>/api/den/...`.

### Optional desktop links, icons, and analytics

| Host | Required or optional | Purpose | What breaks when blocked |
| --- | --- | --- | --- |
| `cdn.simpleicons.org` | Optional | Provider icons. | Some icons are missing. |
| `www.google.com` | Optional | Favicon image service and browser-panel new tab. | Favicons or the embedded browser new tab may not load. |
| `us.i.posthog.com` | Optional | Product analytics, only when analytics are enabled. | Analytics are dropped silently. |
| `openworklabs.com`, `openwork.dev`, `discord.gg`, `ollama.com`, `opencode.ai`, `linear.app`, `mail.google.com`, `code.claude.com` | Optional or opt-in link-only | Docs, feedback, community, provider help, and generated Gmail links. | Links do not open; the core app still runs. |

## Provider and connection access

These are reached only when a user or admin enables that provider, connection, or import path.

| Host | Required or optional | Purpose | What breaks when blocked |
| --- | --- | --- | --- |
| `api.openai.com` | Opt-in | Direct OpenAI Realtime voice and image generation with a user-provided OpenAI key. | Those OpenAI features fail. |
| `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `gmail.googleapis.com`, `chat.googleapis.com` | Opt-in | Google Workspace OAuth plus profile, Calendar, Drive, Gmail, and Chat APIs. | Google Workspace sign-in or actions fail. |
| `mcp.notion.com`, `mcp.linear.app`, `mcp.sentry.dev`, `mcp.stripe.com`, `mcp.context7.com`, `mcp.slack.com` | Opt-in | Built-in MCP connection presets. | That specific MCP connection cannot connect. |
| `api.githubcopilot.com` | Opt-in | Example custom remote MCP URL. | Only a user-configured connection to that URL fails. |
| `api.github.com`, `raw.githubusercontent.com` | Opt-in | Importing GitHub-hosted plugins and skills. | GitHub plugin import cannot inspect or download plugin contents. |

## Self-hosted server (Den) outbound access

Approve Den separately from the desktop client. A Den behind a VPN or in a private cluster uses the server network, not the end-user desktop network.

Hard requirements for self-hosted Den are:

- Your MySQL endpoint, on the port you configured.
- `ghcr.io` on port 443 at image-pull time, unless you mirror the OpenWork images and Helm chart into your own registry.

Everything else is per-feature. For example, Google Workspace requires the Google hosts above, GitHub plugin import requires `api.github.com` and `raw.githubusercontent.com`, OpenAI features require `api.openai.com`, and MCP presets require their individual `mcp.*` host only when enabled.
