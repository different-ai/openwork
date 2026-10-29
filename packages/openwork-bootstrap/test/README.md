# Bootstrap CLI tests

Run on a supported stable Node.js 24.x release (24.22.1 or newer within that
major). The CLI now rejects older releases before executing commands.

Run the CLI tests:

```sh
pnpm --filter openwork-bootstrap test
```

`node-runtime.test.mjs` checks the version floor, the Node 24-only upper bound,
prerelease/malformed version rejection, early command rejection, and `doctor`.
Its fixture substitutes version strings only inside test subprocesses.
`installer-runtime.test.mjs` executes the actual served POSIX shell installer
with isolated downloads and runtimes. It covers supported system Node reuse,
private Node fallback, the exact official 24.22.1 distribution URL and filename,
mirror overrides, checksum failures, and rejection of unsupported private Node.
It requires POSIX shell and tar and is skipped on Windows; no test downloads a
real runtime or changes the user's installation.

The device-login tests run the shipped CLI script in a child process. Each test has a separate HOME and credentials file. The fixture replaces network requests. It controls the clock. It records request times, not codes or tokens.

The tests check these conditions:

- Pending approval keeps the specified poll interval.
- Approval can occur after two minutes.
- `slow_down` adds five seconds to later poll intervals.
- HTTP 429 does not require a specific response body.
- The CLI follows `Retry-After` and `X-Retry-After`.
- A missing or invalid delay cannot cause immediate retries.
- Retries stop at code expiry.
- A request or response body that stops responding is cancelled at expiry.
- Denial, expiry, and invalid grants do not save credentials.

A token received before the device deadline is a completed grant. The session then has its own lifetime. A later `/v1/me` check does not extend device polling.

The protocol tests do not prove server rate-limit behavior. Use `ee/apps/den-api/test/device-login/run.mjs` for that check. See the README in that directory for commands. No local test proves that production is fixed.
