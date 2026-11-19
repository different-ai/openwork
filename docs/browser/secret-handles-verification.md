# Secret handles: what was verified on the real app

This records one end-to-end run of secret handles on the OpenWork desktop app,
what it proved, and what it did not. The feature itself is described in
[secret-handles.md](./secret-handles.md).

## Result

| Check | Result |
| --- | --- |
| `evals/proofs/browser-secret-handles.proof.test.ts`, local, on the merged branch | Passed: 1 test, 7 of 7 recorded checks |
| Visual review of the six screenshots | Not run: the pictures are attached as taken |
| Same proof on `dev` (before the change) | Not run |
| Same proof on Linux or in CI | Not run |
| Cloud browser host, through any product screen | Not available: see "Not covered" |

Command:

```sh
OPENWORK_EVAL_MYSQL_URL=mysql://root:password@127.0.0.1:<port> \
DATABASE_REDIS_URL=redis://127.0.0.1:<port> \
pnpm evals:e2e browser-secret-handles --local
```

## What ran

The proof starts the real stack, each part isolated and thrown away afterwards:

- OpenWork desktop (Electron, from source) with its own profile, its own
  OpenWork server and engine, signed in to a local OpenWork Cloud with a fresh
  database.
- An organization with `browserSecretHandles` off, switched on during the run
  through the same route the `/admin` Features screen uses.
- A sign-in site on `https://billing.localhost:<port>` and a second site on
  `https://tracker.localhost:<port>`, both served from the test process with a
  certificate made for the run.

Nothing in the product was loosened for the run. The store still accepts only
`https://` sites. The desktop is started with
`--ignore-certificate-errors-spki-list=<that certificate's key>` through its
existing `ELECTRON_EXTRA_LAUNCH_ARGS` setting, which trusts that one key in
that one isolated profile. `*.localhost` names resolve to the same computer
without any resolver change.

The password is synthetic, generated per run, and only ever sent to the local
fixture site. The person's side is real input in the app's window (clicks and
keystrokes). The agent's side is the authenticated browser endpoint the
engine's `browser_*` tools call; no model is involved, so the proof does not
show a model choosing to use `fill_secret`.

## What it showed

1. **Feature off.** The browser toolbar has no Secrets control. `fill_secret`
   answers `secrets_unavailable`, and observations offer no secrets.

   ![The built-in browser toolbar with the feature off](./secret-handles/01-feature-off-no-secrets-control.png)

2. **Feature on, no restart.** After the organization's switch is turned on,
   the Secrets key appears in the running app within about a minute.

   ![The Secrets key in the browser toolbar](./secret-handles/02-secrets-key-in-browser-toolbar.png)

3. **Saving a secret.** The person names it, keeps the allowed site the dialog
   filled in from the open page, and types the password into a masked field.
   Once saved it is listed by name, type and site. The value appears nowhere on
   screen.

   ![The Secrets dialog with a masked password](./secret-handles/03-secrets-dialog-masked-entry.png)

   ![The saved secret listed by name and site](./secret-handles/04-secret-saved-by-name-and-site.png)

4. **What the agent is offered.** The observation of the sign-in page lists one
   secret with exactly three fields: `secretRef`, `label` and `kind`.

5. **Approval.** `fill_secret` waits. The chat shows
   `Fill “Billing sign-in” on https://billing.localhost:<port>?` with
   "Password, into a password field." Only after the person chooses Fill does
   the agent get `ok: true, outcome: verified`, with no text or value in the
   reply.

   ![The approval card above the composer](./secret-handles/05-fill-approval-card.png)

6. **The swap.** The fixture site recorded, as yes or no facts:
   - the sign-in request carried the real password: yes, and the site signed
     the person in;
   - the page's own script read the real password from the field: no. It read
     a 32-character placeholder;
   - the request the page sent to the other site carried the real password:
     no. It arrived (one request), with the placeholder;
   - the agent's report for the secret afterwards: `sent`.

7. **Other conversations.** A second conversation on the same page was offered
   no secrets, and `fill_secret` with the first conversation's handle answered
   `unknown_secret`. Across the 10 browser replies the agent received, none
   contained the password, and it was never on the app's screen.

The page itself is not in these pictures: the built-in browser's page is a
separate native view that the app window's screenshot does not include, and a
page that received a secret is not screenshotted by design.

## Not covered

- **No comparison with `dev`.** The proof was not run on the commit before the
  change. It would be expected to stop at step 2, where `dev` does not know the
  `browserSecretHandles` switch, but that was not observed.
- **Agent mouse clicks did not reach the page in this run.** The desktop
  window was not visible on the machine that ran the proof, and the page
  reported itself hidden. A click the agent sent before any secret existed,
  with the feature off, reported `settled` but produced no pointer event in
  the page. So the fixture site sends its form as soon as the password field
  is filled, and the sign-in in step 6 does not depend on a click. A sign-in
  that needs the agent to press a button after `fill_secret` was therefore not
  exercised here.
- **"Don't fill", removing a secret, and turning the feature off mid-run** are
  not in this proof. They are covered by the component and module tests.
- **One-time codes and tokens**, redirects, frames and workers are not in this
  proof. They are covered, where supported, by the desktop host's own page
  tests.
- **The cloud browser host.** Its swap engine is implemented and tested as a
  module, but there is no product screen to save a secret or approve a fill
  for it, and its secret routes are switched off. Nothing here is evidence for
  it.
- **macOS only**, one run, from source rather than a packaged build.

## Reproducing it

Needs MySQL and Redis on this computer (any ports; pass them as above),
`openssl`, and a desktop session, since it opens an Electron window.

```sh
pnpm --filter @openwork/types build
pnpm --filter @openwork-ee/den-db build
pnpm --filter @openwork/email build
pnpm evals:e2e browser-secret-handles --local
```

The report and screenshots land in `evals/results/test-runs/<latest>/`.
