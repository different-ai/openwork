---
name: fake-model-faults
description: Make the desktop's model provider fail on demand (connection refused, DNS not found, socket reset, 429, 5xx, 401, 402, stalled or cut stream) with a local fault server and test providers. Use when reproducing or designing model error and retry states without a real outage.
---

# Fake model faults

Real provider errors come from the engine (the opencode sidecar), not from the window, so CDP network throttling cannot produce them. This skill points test providers at failures instead.

## Set up

```bash
F=.opencode/skills/fake-model-faults/scripts
node $F/fault-server.mjs &                          # 127.0.0.1:55600 (PORT=… to change)
python3 $F/fault-providers.py add                   # backs up runtime.sqlite, adds three providers
CDP_URL=http://127.0.0.1:<cdp> node .opencode/skills/drive-desktop-cdp/scripts/cdp.mjs refresh-providers   # expect 200
```

Writing the v2 engine config directly does not stick; the server rewrites it from the global runtime config within seconds. `refresh-providers` saves a dummy `fault-lab` key so the server mirrors providers immediately.

## What each model does

| Provider · model | Engine error you get |
|---|---|
| Fault Refused · `refused` | `ConnectionRefused: Unable to connect…` (closed port), with retries |
| Fault DNS · `enotfound` | `getaddrinfo ENOTFOUND …` (a `.invalid` host), with retries |
| Fault Lab · `reset` | `ECONNRESET: The socket connection was closed unexpectedly…`, with retries |
| Fault Lab · `mid-stream-reset` | partial reply, then the socket closes |
| Fault Lab · `stall` | the request never answers |
| Fault Lab · `http-429` / `http-500` / `http-503` / `http-401` / `http-402` | that HTTP status with a JSON error body |
| Fault Lab · `ok` | a normal short reply (checks the pipeline) |

A DNS timeout (`getaddrinfo ETIMEOUT`) and the "OpenWork Cloud is temporarily unavailable" banner need a real network cut: turn Wi-Fi off for about 40 seconds (`networksetup -setairportpower en0 off`, then `on`). Ask first; it drops the whole machine, including VPNs.

## Clean up

```bash
python3 $F/fault-providers.py remove
CDP_URL=… node .opencode/skills/drive-desktop-cdp/scripts/cdp.mjs eval '(async()=>{const w=(location.hash.match(/#\/workspace\/([^/]+)/)||[])[1];const r=await fetch("http://127.0.0.1:"+localStorage.getItem("openwork.server.port")+"/workspace/"+w+"/opencode/auth/fault-lab",{method:"DELETE",headers:{Authorization:"Bearer "+localStorage.getItem("openwork.server.token")}});return r.status})()'
kill %1   # the fault server
```
