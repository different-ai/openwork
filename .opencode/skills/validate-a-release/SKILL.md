---
name: validate-a-release
description: Validate the release, check the released binaries, is 0.18.x safe to roll out, prove a published desktop release. Boots the RELEASED mac-arm64 enterprise and cloud binaries through the packaged journeys, checks updater manifests and notarization, and publishes evidence.
---

# Skill: validate-a-release

Run after `release` reports the GitHub release published. Every check runs on
the artifacts users download, never on a local build. macOS arm64 host, MySQL
on `127.0.0.1:3306` (`pnpm dev:den:mysql`), `gh` authenticated. Work from a
clean checkout (evidence is bound to its `git HEAD`): `origin/dev` today; from
the first release that ships these specs, the tag's own checkout
(`git worktree add /tmp/ow-vX.Y.Z vX.Y.Z`) so the gate matches the binary.

## 1. Download and unpack

`V` is the release under test, `B` the previous release existing users update from.

```bash
export V=0.18.45 B=0.18.42
export R=/tmp/ow-release-$V; mkdir -p $R && cd $R
gh release download v$V -R different-ai/openwork -p "openwork-enterprise-mac-arm64-$V.zip" -p "openwork-cloud-mac-arm64-$V.zip" -p '*.yml' --clobber
gh release download v$B -R different-ai/openwork -p "openwork-enterprise-mac-arm64-$B.zip" --clobber
for s in enterprise:$V cloud:$V enterprise:$B; do f=${s%%:*}; v=${s##*:}; rm -rf $f-$v; mkdir $f-$v
  ditto -x -k openwork-$f-mac-arm64-$v.zip $f-$v && xattr -dr com.apple.quarantine $f-$v; done
export ENT="$R/enterprise-$V/OpenWork Enterprise.app" CLOUD="$R/cloud-$V/OpenWork Cloud.app" BASE="$R/enterprise-$B/OpenWork Enterprise.app"
```

## 2. Signing and notarization

```bash
for app in "$ENT" "$CLOUD"; do codesign --verify --deep --strict "$app" && spctl -a -t exec -vv "$app"; done
```

Expect `accepted`, `source=Notarized Developer ID`, `origin=Developer ID Application: Different AI inc. (F5DJWB4CCV)`.

## 3. Updater manifests

```bash
grep -H '^version:' enterprise*.yml cloud*.yml            # every line must be: version: $V
gh release view v$V -R different-ai/openwork --json assets --jq '.assets[].name' > assets.txt
grep -h 'url: ' enterprise*.yml cloud*.yml | awk '{print $NF}' | sort -u | while read u; do grep -qx "$u" assets.txt && echo "ok $u" || echo "MISSING $u"; done
for f in enterprise cloud; do zip=openwork-$f-mac-arm64-$V.zip
  want=$(awk -v z="$zip" '$0 ~ "url: "z {f=1} f && /sha512:/ {print $2; exit}' $f-mac.yml)
  have=$(openssl dgst -sha512 -binary $zip | base64); [ "$want" = "$have" ] && echo "$zip sha512 OK" || echo "$zip sha512 MISMATCH"; done
```

Any `MISSING`, `MISMATCH`, or wrong version means the updater will fail or refuse the download: stop and report.

## 4. Journeys (from the repo root)

The app installs any newer public release over itself when it quits (ShipIt
swaps the `.app` in place; builds before #4726 do it even before activation),
so never launch an extracted bundle directly: `clone` gives each journey a
throwaway APFS copy, and journey 3+4 clones internally.

```bash
export OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED=1 OPENWORK_EVAL_ENGINE=v1 OPENWORK_EVAL_SURFACES_DIR=/tmp/ow-profiles-$V
clone() { rm -rf "$R/clone"; mkdir "$R/clone"; cp -Rc "$1" "$R/clone/"; }
```

| # | Journey | Command |
|---|---------|---------|
| 1 | Fresh enterprise install shows the activation gate, 0 render crashes | `clone "$ENT"; OPENWORK_EVAL_ELECTRON_BINARY="$R/clone/OpenWork Enterprise.app/Contents/MacOS/OpenWork Enterprise" pnpm evals:e2e packaged-first-launch --local` |
| 2 | Fresh cloud install shows the welcome page, 0 render crashes | `clone "$CLOUD"; OPENWORK_EVAL_ELECTRON_BINARY="$R/clone/OpenWork Cloud.app/Contents/MacOS/OpenWork Cloud" pnpm evals:e2e packaged-first-launch --local` |
| 3+4 | Activated enterprise install boots to `/signin`; a `$B` signed-in profile opens in `$V` and again after restart | `OPENWORK_EVAL_ELECTRON_BINARY="$ENT/Contents/MacOS/OpenWork Enterprise" OPENWORK_EVAL_RELEASED_BASELINE_BINARY="$BASE/Contents/MacOS/OpenWork Enterprise" OPENWORK_EVAL_RELEASED_VERSION=$V pnpm evals:e2e released-enterprise-activated --local` |

Each command must end with `"verdict":"passed"` and `"skipped":0`. Journey 3+4
without `OPENWORK_EVAL_RELEASED_BASELINE_BINARY` skips the update test and the
verdict is `incomplete`, never passed. Before each journey confirm the
extracted bundle is still the release:
`/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$ENT/Contents/Info.plist"` must print `$V` (re-extract if not).

Second lane for 3+4 against a Den built from the release tag (covers the Den
the release ships with, not just the local one):

```bash
bash .devcontainer/test-server-on-daytona.sh v$V --seed --name release-$V-den --auto-stop 90   # prints DEN_WEB_URL / DEN_API_URL
OPENWORK_EVAL_DEN_WEB_URL=<DEN_WEB_URL> <same variables as journey 3+4> pnpm evals:e2e released-enterprise-activated --den <DEN_API_URL>
daytona delete release-$V-den
```

Journeys 1 and 2 also fail on any unhandled rejection outside
`KNOWN_LAUNCH_REJECTIONS` (evals/worlds/packaged-first-launch.ts). A release
that predates a fix already on `dev` fails there with `Uncaught (in promise)`
entries (0.18.45 and 0.18.46: two `OpenWork must be activated…` IPC rejections,
fixed by #4727). Report those messages verbatim as `Failed`; a render crash
(no `(in promise)` prefix) or the recovery screen is a rollout blocker.

Negative control when a regression is suspected: run journey 1 with the last
known-bad release; it must fail (for 0.18.44 it fails with `Local context is missing`).

## 5. Publish evidence

Test runs land in `evals/results/test-runs/<timestamp>-<test>` with the
checkout's `gitSha`. Publish each run to the PR or issue that tracks the
release; without a PR, keep the run directories and quote the JSON verdict lines:

```bash
infisical run --silent -- pnpm evals:e2e --publish --pr <n> --test-run <dir>
```

## What this proves and does not prove

Proves, on the released mac-arm64 binaries: Developer ID signature and
notarization; fresh-profile first launch of both flavors mounts its gate with
zero renderer exceptions and no recovery screen; an already-activated
enterprise install pointed at a real Den boots past the gate to the interactive
sign-in surface and reports version `$V`; a profile created and signed in by
`$B` opens in `$V` straight into the same workspace route, and again after a
restart, with zero renderer exceptions; all updater manifests name `$V`, point
at existing assets, and the mac-arm64 sha512s match.

Does not prove: mac-x64, Windows, or Linux binaries boot (only their manifest
entries are checked); the real electron-updater download/apply path (the update
is simulated by opening the `$B` profile with `$V`); a customer's self-hosted Den
version, branding, or policies; SSO/browser sign-in (sign-in uses the handoff
grant); or any chat/model work after boot.
