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
selects the guest OS. `preview-desktop --place freestyle` runs the signed-out
`fresh` Linux desktop snapshot from a pushed commit (`--source desktop=ref:dev`
by default); other scenarios, releases and Den sources are refused before a VM
is created. Local uses this computer's OS, Freestyle offers Linux,
and Daytona offers Linux or Windows. Daytona Windows supports only
`preview-desktop` with `--source desktop=release:<x.y.z>/<distribution>
--seed blank`; source builds and Den-only Windows previews fail before
provisioning. Only the listed `supportedTargets` are advertised; a custom
script without a declaration can run locally but fails closed remotely.

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
- Daytona Windows published desktop previews use an owned, private VM, verify
  the installer digest, launch in the interactive user session, and check the
  private viewer and CDP. They do not run source builds or seed Den identity.
  Use `--lifetime 0-1410` after `--` (0 means until stopped); the VM has an
  additional 30-minute startup allowance and a provider-side TTL so a crashed
  driver cannot leave an unbounded VM.
- Script worlds can compose the named preview scenario seeds; arbitrary seed
  functions, provider-side expiry after driver crashes, and fully independent
  desktop/Den source checkouts are not implemented.
