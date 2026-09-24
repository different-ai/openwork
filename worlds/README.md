# Composing script worlds

A script world is a disposable, reproducible environment driven by `pnpm world`.
The building blocks are `server()` (Den), `app()` (Electron), `appWeb()`,
seeding helpers, and `hold()` (lifetime and outputs). Use `AsyncDisposableStack`
to own resources so stopping the world tears them down in reverse order.

```sh
pnpm world help preview-desktop --json
pnpm world list
pnpm world up preview-desktop --place daytona --stage example \
  --source den=ref:dev --source desktop=release:0.18.52/enterprise --seed blank --detach
pnpm world outputs preview-desktop --stage example --json
pnpm world down preview-desktop --stage example
```

`--place` selects who runs it (`local`, `daytona`, or `freestyle`); `--os`
selects the guest OS. Local uses this computer's OS, Freestyle offers Linux,
and Daytona offers Linux or Windows. **The Windows desktop host is not wired
into script worlds yet**, so Windows requests fail before provisioning. Only
the listed `supportedTargets` are advertised; a custom script without a
declaration can run locally but fails closed for remote providers.

`--source` and `--seed` are **opt-in**. Today `preview-den` and
`preview-desktop` accept component sources (`den`, `desktop`) and a single
scenario seed (`fresh`, `team`, `restricted`, `workspace`, `blank`). `app-web`
and `acme-web` accept one default SHA/ref source on Daytona or Freestyle,
mapped to the existing `--ref` input or the Daytona Den ref. Other worlds reject these flags rather than silently
ignoring them. Use existing script
arguments after `--` for the others. Source refs resolve to immutable Git SHAs
before adopting a running stage. Published releases need an exact version and
`public`, `cloud`, or `enterprise` distribution. The CLI fingerprints the
resolved source and seed with the rest of the invocation. Daytona scripts that
use `resolvePlace()` also pin an omitted source to the current `origin/dev`
commit before adoption rather than silently reusing an older branch tip.

In a script, declare supported targets as a literal string array so discovery
can read it **without importing or running** your script:

```ts
export const supportedTargets = ["local/host", "daytona/linux"];
```

Do not advertise a target until its provisioning and teardown actually work.
For a new composition, export a `boot(stack, place)` function for reuse in tests
and other scripts, then have `main()` resolve the place and call `hold()`.
Do not use raw infrastructure IDs, customer data, or production credentials
in world definitions or seed fixtures.

Note: `evals/worlds/` contains test fixtures with a different lifecycle; those
are not script worlds runnable with `pnpm world`.

## Current boundaries

- Review-app PR launches still use the Freestyle snapshot/VM API directly;
  `world up app-web --place freestyle` uses the same provider path, but the
  review service does not call the local world CLI.
- Daytona Windows has a manual sandbox workflow, not an interactive desktop
  host, release installer, CDP probe, viewer, or world-owned teardown. Do not
  advertise a Windows preview until those are verified end-to-end.
- Script worlds can compose the named preview scenario seeds; arbitrary seed
  functions, provider-side expiry after driver crashes, and fully independent
  desktop/Den source checkouts are not implemented.
