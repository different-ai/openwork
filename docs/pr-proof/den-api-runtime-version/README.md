# Den API runtime version proof

The fraimz flow drives a browser to the public Den `GET /health` endpoint and
asserts that the response is healthy, identifies `den-api`, and reports the
expected running version.

![Den API health response reporting version 0.17.31](./den-api-runtime-version.png)

Run locally with a Den API and CDP browser available:

```bash
OPENWORK_EVAL_DEN_API_URL=http://127.0.0.1:37300 \
OPENWORK_EVAL_DEN_API_VERSION=0.17.31 \
pnpm fraimz --flow den-api-runtime-version --cdp-url http://127.0.0.1:37309
```

See [report.md](./report.md) for the recorded assertions and voice-over
coverage from the passing run.
