# Microsandbox OpenWork Rust Example

Small standalone Rust example that starts the OpenWork micro-sandbox image with the `microsandbox` SDK, publishes the OpenWork server on a host port, persists `/workspace` and `/data` with named microsandbox volumes, verifies `/health`, checks that `/workspaces` is `401` without a token and `200` with the client token, then keeps the sandbox alive until `Ctrl+C` while streaming the sandbox logs to your terminal.

## Run

```bash
cargo run --manifest-path examples/microsandbox-openwork-rust/Cargo.toml
```

Useful environment overrides:

- `OPENWORK_MICROSANDBOX_IMAGE` - OCI image reference to boot. Defaults to `openwork-microsandbox:dev`.
- `OPENWORK_MICROSANDBOX_NAME` - sandbox name. Defaults to `openwork-microsandbox-rust`.
- `OPENWORK_MICROSANDBOX_WORKSPACE_VOLUME` - named volume mounted at `/workspace`. Defaults to `<sandbox-name>-workspace`.
- `OPENWORK_MICROSANDBOX_DATA_VOLUME` - named volume mounted at `/data`. Defaults to `<sandbox-name>-data`.
- `OPENWORK_MICROSANDBOX_REPLACE` - set to `1` or `true` to replace the sandbox instead of reusing persistent state. Defaults to off.
- `OPENWORK_MICROSANDBOX_PORT` - published host port. Defaults to `8787`.
- `OPENWORK_CONNECT_HOST` - hostname you want clients to use. Defaults to `127.0.0.1`.
- `OPENWORK_TOKEN` - remote-connect client token. Defaults to `microsandbox-token`.
- `OPENWORK_HOST_TOKEN` - host/admin token. Defaults to `microsandbox-host-token`.

Example:

```bash
OPENWORK_MICROSANDBOX_IMAGE=ghcr.io/example/openwork-microsandbox:dev \
OPENWORK_MICROSANDBOX_WORKSPACE_VOLUME=openwork-demo-workspace \
OPENWORK_MICROSANDBOX_DATA_VOLUME=openwork-demo-data \
OPENWORK_CONNECT_HOST=127.0.0.1 \
OPENWORK_TOKEN=some-shared-secret \
OPENWORK_HOST_TOKEN=some-owner-secret \
cargo run --manifest-path examples/microsandbox-openwork-rust/Cargo.toml
```

## Persistence behavior

By default, the example creates and reuses two named microsandbox volumes:

- `/workspace`
- `/data`

That keeps OpenWork and OpenCode state around across sandbox restarts, which avoids stale-client behavior caused by throwing away server state every time.

If you want a clean reset, either:

- change the sandbox or volume names, or
- set `OPENWORK_MICROSANDBOX_REPLACE=1`

## Note on local Docker images

`microsandbox` expects an OCI image reference. If `openwork-microsandbox:dev` only exists in your local Docker daemon, the SDK may not be able to resolve it directly. In that case, push the image to a registry or otherwise make it available as a pullable OCI image reference first, then set `OPENWORK_MICROSANDBOX_IMAGE` to that ref.
