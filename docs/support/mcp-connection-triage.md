# MCP connection triage

Use this runbook when **cloud MCP failed but sign-in/models/inference work**. That symptom means the user's Den session and model path are alive; the failure boundary is the Cloud MCP endpoint, the engine's MCP registration path, trust gating, or the customer network/TLS route.

## 1. Get the structured diagnostic first

1. Get the customer on OpenWork **0.18.7 or newer**.
2. Have them run **Settings → Advanced → Developer mode**, then **Settings → Debug → Run agent diagnostics → Copy report**.
3. Read these checks first:
   - `cloud-tool-catalog`
   - `cloud-endpoint-transport`
   - `cloud-endpoint-differential`
4. Use the public reference for exact code lookup: [`agent-diagnostics-reference.mdx`](../../packages/docs/start-here/troubleshooting/agent-diagnostics-reference.mdx).

## 2. If the probe is gated, fix trust before chasing the network

If `cloud-tool-catalog.code` is `untrusted_endpoint` and `cloud-tool-catalog.details.enterpriseActivationPresent` is `false`, no request was sent. This is not a TLS, DNS, or HTTP result.

Fix with one of these paths:

- Re-activate the install through a fresh organization install/connect link so `desktop-bootstrap.json` contains the enterprise activation origin again.
- Or relaunch OpenWork from a terminal with the exact trusted Den origin in the process environment:

```bash
OPENWORK_AGENT_DIAGNOSTICS_TRUSTED_ORIGINS=https://<den-origin> /Applications/OpenWork.app/Contents/MacOS/OpenWork
```

After either change, fully restart OpenWork and rerun the diagnostic.

## 3. Surface map

| Surface | What it gives you | Use it for |
| --- | --- | --- |
| Agent diagnostic report | Sanitized, structured report with closed cause codes, stages, details, and differential verdicts. | Primary evidence and safe customer-shareable artifact. |
| **Settings → Advanced → Agent access diagnostics** panel | The engine's live per-server error string in the **Engine MCP servers** row. | Compare the engine's live text with `engine-mcp-sync.details.failedRegistrations[].errorSummary`. |
| Engine log grep | Recent raw engine connection messages. | Confirm what OpenCode saw at registration time. |

Run the log grep on the affected machine:

```bash
grep -i "openwork-cloud\|SSE error" ~/.local/share/opencode/log/*.log | tail -20
```

Decoder for common log strings:

| Log string | Usually means |
| --- | --- |
| `typo in the url or port?` | DNS resolution or endpoint typo. |
| `unable to connect` | Firewall, route, listener, VPN, or connectivity failure. |
| `self signed certificate` | Trust chain includes an untrusted private/self-signed CA. |
| `unable to verify the first certificate` | Incomplete served chain, commonly leaf-only TLS. |
| Repeated non-200 5xx | Upstream proxy, gateway, or Den service failure. |

## 4. TLS commands that do not lie

Always inspect what the server actually serves:

```bash
openssl s_client -connect <den-host>:443 -servername <den-host> -showcerts </dev/null 2>&1 | tee /tmp/openwork-showcerts.txt
grep -c "BEGIN CERT" /tmp/openwork-showcerts.txt
```

Rules:

- Use `openssl s_client -showcerts` and count certificates with `grep -c "BEGIN CERT"`.
- Never pipe `s_client` directly through `openssl x509` while triaging; that can swallow the verify error line you need.
- A bare successful `curl` does not prove the chain is complete. macOS curl can use system trust and AIA-style fetching.
- Browser success proves nothing about non-browser clients; browsers can fetch missing intermediates that OpenWork/OpenCode runtimes do not fetch.

For a public CA leaf, a count of `1` usually means the customer is serving only the leaf. The first server-side fix is serving the fullchain at the TLS terminator.

## 5. Evidence bundle checklist

Ask for all of these before escalating:

- Agent diagnostics report JSON.
- **Settings → Advanced → Agent access diagnostics** copy or screenshot, especially the **Engine MCP servers** row.
- Engine log tail from the grep command above.
- `openssl s_client -showcerts` output and certificate count.
- OpenWork app version.
- Operating system and version.

## Mechanics footnote

The engine re-attempts a failed MCP only on restart or repair. Always fully restart OpenWork/the selected engine between customer-side changes before declaring the change ineffective.
