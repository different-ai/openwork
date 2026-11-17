# Operational diagnostics

`operationalDiagnostics` is available on cloud and self-hosted Den, off by
 default. Owner: `openwork`.

This optional local snapshot contains only schema version 1, product version,
instance kind, known deployment kind, coarsely bucketed uptime, minute-truncated
UTC time, and the fixed component states `ok`, `degraded`, `down`, `unknown`.
Components are database, migrations, worker, engine and local server. Unavailable
checks are unknown, never assumed healthy. There are no identifiers, addresses,
paths, messages, connector/model/provider names, or population counts. No error
or queue counters are collected. Snapshots are validated before writing; invalid
snapshots and producer/write failures produce no diagnostic error output.

## Desktop

Add to the existing `desktop-bootstrap.json`:

```json
{"diagnostics":{"enabled":true,"output":"file","intervalMinutes":60}}
```

The operator block and the active organization's resolved
`operationalDiagnostics` feature must both be enabled. Missing, signed-out,
unresolved or failed feature discovery stays off. The renderer uses the existing
organization feature resolver and passes only its boolean to Electron; no
snapshot is sent over IPC or the network. Turning the flag off stops the timer
and suppresses pending writes when the resolved value refreshes. Restart after
changing the bootstrap configuration. The single `operational-diagnostic.json`
file under the app's existing local `userData/logs` directory is overwritten,
not appended. Disabling does not delete an existing snapshot.

## Den API (Helm, managed or direct)

```yaml
config:
  diagnostics:
    enabled: true
    output: stdout
    intervalMinutes: 60
```

Helm passes this strict block as JSON in `DEN_DIAGNOSTICS`; direct or managed
operators may set the same environment variable. By default Helm adds no new
environment variable. The process emits a line prefixed
`OPENWORK_OPERATIONAL_DIAGNOSTIC ` immediately on starting, then at the configured
interval. The database state reuses the readiness query; other unavailable
checks remain unknown. Timers are unreferenced and stopped during shutdown,
without waiting for probes or writes.

The server snapshot is process-scoped, not organization-scoped. Organization
feature rollouts cannot safely authorize or suppress output for a whole replica:
choosing any organization's flag would make another organization's setting
control the process. Therefore the server is gated only by the explicit operator
block, not by `operationalDiagnostics`. No parallel process flag is introduced.
The registry flag gates only desktop consumption of resolved organization flags.
Disable the server block and restart to stop it.

`enabled` defaults to false, `intervalMinutes` defaults to 60 and is an integer
from 5 through 1440. `output` is `stdout` or `file`, defaulting to stdout on the
server and file on desktop. This release writes only stdout on the server and
only a file on desktop; choosing the other surface's output writes nothing.
No remote destination exists. Nothing is sent to OpenWork or any other endpoint.
Existing operator log collectors may independently ship stdout; review their
configuration before enabling server output.

Watch the local output for `down` states; `unknown` is not proof of readiness.
This feature does not make a live managed install verified or ready.
