# @openwork/app-tools

Validation, deterministic packaging, and verification for OpenWork Apps.

These are the same routines the OpenWork host runs when it installs an app. A
package that verifies here is a package the host will accept; one rejected here
would have been rejected on a user's machine.

```bash
openwork-app validate openwork.app.json

openwork-app pack \
  --root . \
  --out dist/notes-1.0.0.owapp \
  --repository https://github.com/example/notes \
  --tag v1.0.0 \
  --commit "$(git rev-parse HEAD)"

openwork-app verify dist/notes-1.0.0.owapp
```

`pack` writes the archive and a sibling `.sha256`. Publish both as release
assets; OpenWork pins the digest when the user reviews the app and refuses
anything else at install time.

## The `.owapp` format

A ZIP containing:

- `openwork.app.json` — the manifest, byte-for-byte as authored
- the app's bundled assets
- `META-INF/openwork-package.json` — per-file sizes and SHA-256 digests, the
  manifest digest, and the source repository, release tag, and commit

The metadata closes the archive: every other entry must be listed, and every
listed entry must be present. An extra file smuggled in and a missing file are
both detected without trusting the ZIP directory.

## Determinism

The same file set packed by the same tool build produces byte-identical output.
Entries are sorted by path, timestamps are fixed at the 1980 ZIP epoch, no
extra fields or directory entries are written, and external attributes are
zeroed — so nothing about the building machine leaks into the digest.

Cross-zlib-version byte reproducibility is not claimed. Integrity does not
depend on it: every digest is taken over uncompressed content and over the
finished archive.

## What the reader refuses

The archive reader is the attack surface, so it fails closed on path traversal
(`..`, absolute paths, backslashes, drive letters), symlink entries, directory
entries, duplicate names, local headers that disagree with the central
directory, encrypted entries, data descriptors, unsupported compression
methods, ZIP64, decompression bombs, oversized entries, and CRC mismatches.

Extraction is separately defended: paths are re-checked against the destination
root, files are written with an exclusive flag so a planted symlink is an error
rather than a redirected write, and the install directory is renamed into place
atomically so a crash never leaves a runnable half-install.

## Using this outside the OpenWork monorepo

`openwork-app` has one runtime dependency, `@openwork/app-contract`. It reads a
directory, produces an archive, and exits with a status code: 0 accepted, 1
rejected, 2 usage error. It runs no build scripts and executes nothing from the
app directory.
