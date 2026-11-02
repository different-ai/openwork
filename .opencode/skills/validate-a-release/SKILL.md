---
name: validate-a-release
description: Validate the release, check the released binaries, is 0.18.x safe to roll out, prove a published desktop release. Checks the RELEASED mac-arm64 enterprise and cloud binaries' signing and notarization and the updater manifests, and publishes evidence.
---

# Skill: validate-a-release

Run after `release` reports the GitHub release published. Every check runs on
the artifacts users download, never on a local build. macOS arm64 host, `gh`
authenticated.

Booting packaged builds is covered before release, not here: the Linux
packaged smoke (`app-smoke`, "Packaged desktop smoke", which every alpha
release waits for) and the macOS signed update install
(`packaged-update-install`) in the scheduled `ci-tests.yml` run. Check that
the release commit's alpha run and latest scheduled run passed both.

## 1. Download and unpack

`V` is the release under test.

```bash
export V=0.18.45
export R=/tmp/ow-release-$V; mkdir -p $R && cd $R
gh release download v$V -R different-ai/openwork -p "openwork-enterprise-mac-arm64-$V.zip" -p "openwork-cloud-mac-arm64-$V.zip" -p '*.yml' --clobber
for f in enterprise cloud; do rm -rf $f-$V; mkdir $f-$V
  ditto -x -k openwork-$f-mac-arm64-$V.zip $f-$V && xattr -dr com.apple.quarantine $f-$V; done
export ENT="$R/enterprise-$V/OpenWork Enterprise.app" CLOUD="$R/cloud-$V/OpenWork Cloud.app"
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

## 4. Publish evidence

Post the command output from steps 2 and 3 (the `spctl` lines, the version
grep, and the `ok`/sha512 lines) to the PR or issue that tracks the release.

## What this proves and does not prove

Proves, on the released mac-arm64 binaries: Developer ID signature and
notarization; all updater manifests name `$V`, point at existing assets, and
the mac-arm64 sha512s match.

Does not prove: that the released binaries boot (that is proven on the release
commit's packaged builds by `app-smoke` and `packaged-update-install`, not on
the downloaded artifacts); mac-x64, Windows, or Linux signing (only their
manifest entries are checked); a customer's self-hosted Den version, branding,
or policies; SSO/browser sign-in; or any chat/model work after boot.
