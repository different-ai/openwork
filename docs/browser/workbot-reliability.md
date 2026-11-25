# Cloud Workbot browser reliability investigation — 2026-11-07

## Evidence and confidence

The reproduction used the real `packages/computer-use/chromium.mjs` and
`browser-task.mjs` against a disposable headed Chrome profile on loopback.
It did not operate on the production conversation or restart production VMs.

| Reported symptom | Code cause and confidence |
| --- | --- |
| `open` fails before dispatch | **Unconfirmed production cause.** `dispatched:false` means failure before the host's navigation admission callback: destination validation, tab creation, ownership persistence or connection setup. The old catch discarded the actual exception. A stale existing page alone does not explain a new open failing. New metadata-only diagnostics distinguish connection loss, receipt timeout, missing runtime dependency and unexpected failures. Do not infer a specific capacity/Chrome issue without guest logs. |
| Navigation fails although YouTube loaded | **Confirmed locally.** On a first visit YouTube navigated to `?themeRefresh=1`. The original `Page.navigate` loader ID never matched the new document, so the old 100×50ms loop timed out after about 6.3 seconds. It reported `browser_operation_failed` despite the tab showing YouTube. The old open path also lost the created tab ID when loading threw. |
| Extraction returns zero characters | **Confirmed code gap; production trigger not proven.** Extraction immediately read `document.body.innerText`, with no readiness wait and no distinction between empty/loading and no matching passage. It covers the top document only. A SPA boot, empty render or frame/canvas-only page can yield zero. Local YouTube after loading produced readable text; no evidence establishes a consent wall or wrong frame in production. Now navigation settles before returning, empty extraction waits a bounded four seconds and reads again, and empty-text guidance says to inspect an image. |
| Observation says `page_changed` | **Confirmed locally, repeatedly.** Every iframe's `Page.frameNavigated` and every destroyed execution context incremented the whole tab's revision. YouTube embeds triggered this during image observations. Now only the main frame and the actual isolated observation world invalidate the document. Real main-page changes still invalidate it. Context acquisition/evaluation races normalize to `page_changed`; the flagged recovery reads once more after settling. |
| `needs_attention` / `Check browser` without recovery | **Confirmed.** The catch published attention for every error, even transient page changes, with a generic label. This is presentation state, not an input lock. A subsequent successful operation already cleared it; nothing was automatically repairing a disconnected CDP socket. Transient races now leave the tab usable/idle, errors retain codes and tab identity, and the flagged next-operation reconnect replaces a closed socket without replaying input. |
| Nov 4 snapshot/start timeout | **Confirmed misdiagnosis; underlying boot delay unknown.** `desktop-bridge.py` checks installed image identities before running installed `start.sh` with a 30-second subprocess limit. Reaching that timeout proves the helper reached startup, not that it was absent. `Desktop.prepare` formerly called any non-identity failure a missing snapshot. It now distinguishes runtime startup failure from a confirmed missing helper and health-checks timeouts without automatically relaunching. |
| Phone only shows working header/Open Computer; grey connecting view | The working-line design and 15-second viewer connection timeout are in the earlier UI changes. Those do not fix browser loading, CDP observation races or startup. The agent can spend its turn on failed tools without useful text. UI acknowledgements, preview cards and last-frame retention are owned by a separate UI change; no viewer/stream code changes here. |

## Runtime and boundaries

`desktop` tool → `Computers.desktopRun` → restricted `openwork-desktop-bridge`
→ authenticated `desktop-guest.mjs` → `createCloudComputer` →
`createCloudBrowser` (CDP) → shared browser task host.

Browser and native apps use separate X displays (`:100` and `:99`). The image's
installed startup script is sourced from
`ee/apps/den-worker-runtime/scripts/cloud-desktop.sh`; its trusted installed
path is `/usr/local/share/openwork-desktop/start.sh`. The helper and startup
script are image inputs. The browser code is guest input and supports existing
in-place guest updates. Neither image input is changed by this fix.

Network interception and the browser UID's kernel egress filter remain required.
There is no fallback that disables policy or reaches private networks. Tab
ownership is preserved. Stale tabs are not discarded; a new URL already opens
in a new owned tab. No clicks, typing, submissions or navigation are replayed.
A timeout means an unconfirmed outcome, not proof that Chromium stopped.

## Rollout

See [workbotBrowserRecovery](../features/workbot-browser-recovery/README.md).
The new recovery and blocker guidance are default off. Wait/load/iframe/error
fixes restore existing intended behavior and are unflagged. This does not deploy
or build a provider snapshot, change capacity, or turn the feature on for anyone.

## Operations follow-up

**Workbot runner / sandbox image operator:** inspect existing
`[headless-computer] desktop timing` records plus runtime logs under
`/run/openwork-desktop/{99,100}/` and `/var/lib/openwork-desktop/guest.log` for
startup stages. Determine whether the 30-second budget was spent on display,
Chromium, file policy or VNC-window discovery. Change startup budgets/stale
profile recovery only with a separately built and tested image.

**Sandbox/provider operator:** for a genuinely missing or incompatible image,
build/publish the matching desktop snapshot and configure the runner's
`HEADLESS_COMPUTER_SNAPSHOT` or gateway template mapping. Check provider node
capacity and checkpoint restore latency before attributing this incident to
capacity. The repository already has compatible-image fallback and in-place
guest installation; verify the actual configured image/version before replacing
machines. No production rebuild, restart or capacity change was performed here.

## Re-run

The committed `packages/computer-use/scripts/prove-browser-recovery.mjs` drives
real YouTube search via fill + Enter, text reads, image observations and a
cross-site navigation in a **disposable** Chrome profile. It writes PNG evidence
and metadata receipts outside the repository. Run both with and without
`--recovery`. Linux images provide ImageMagick; the local macOS reproduction
used a Pillow resize shim in the test harness because `convert` was not installed.
That screenshot harness substitution is not a production dependency change or
proof of Linux snapshot boot readiness.
