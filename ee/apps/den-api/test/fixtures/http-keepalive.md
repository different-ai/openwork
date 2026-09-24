# Origin keep-alive regression

The deterministic regression is `pnpm --filter @openwork-ee/den-api test:http-server`.
It uses real TCP, checks reuse beyond the old six-second idle-close boundary,
checks that header/body timeouts are unchanged, and checks idle shutdown.

The optional probe below exercises the race itself. It compares Hono's original
defaults (port 4101) with the production `serveDenHttp` factory (port 4102), using
Node 24.21.0 and Go's HTTP transport. The transport uses cloudflared's documented
90-second origin pool timeout, without a replay callback for POST bodies.
Each origin receives at most 800 synthetic POST attempts over loopback. No ports
are published, no Den application/DB is booted, and no credentials are required.

From the repository root after installing dependencies:

```sh
docker run -d --rm --name den-origin-keepalive-probe \
  -v "$PWD:/repo:ro" node:24.21.0-bookworm-slim \
  node /repo/ee/apps/den-api/test/fixtures/http-keepalive-origins.mjs
docker logs den-origin-keepalive-probe # wait for ready 4101 and ready 4102
docker run --rm --network container:den-origin-keepalive-probe \
  -v "$PWD/ee/apps/den-api/test/fixtures/http-keepalive-proxy.go:/probe.go:ro" \
  golang:1.26-bookworm go run /probe.go
docker stop den-origin-keepalive-probe
```

The failure count is timing-dependent; zero control failures is inconclusive,
not proof of correctness. This is a transport-mechanism reproduction, not a
production failure-rate estimate, a real Cloudflare Tunnel, or proof that every
production EOF/reset has this cause. The new idle lifetime remains bounded;
deploy shutdown and active stream behavior are not changed by this fix.

References:
- [Cloudflare origin keepAliveTimeout](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#keepalivetimeout)
- [cloudflared Go origin transport](https://github.com/cloudflare/cloudflared/blob/master/ingress/origin_service.go)
