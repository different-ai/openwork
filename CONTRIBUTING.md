# Contributing to OpenWork

## Contributor License Agreement and Developer Certificate of Origin

Contributions to this repository are subject to the
[Developer Certificate of Origin](https://developercertificate.org/), or the
[Individual](./legal/individual-contributor-license-agreement.md) or
[Corporate](./legal/corporate-contributor-license-agreement.md) Contributor
License Agreement, depending on where the contribution is made and on whose
behalf, unless otherwise agreed with Different AI, Inc. in writing:

- By submitting code contributions as an individual to the
  [`ee/` directory](./ee) of this repository, you agree to the
  [Individual Contributor License Agreement](./legal/individual-contributor-license-agreement.md).
- By submitting code contributions on behalf of a corporation to the
  [`ee/` directory](./ee) of this repository, you agree to the
  [Corporate Contributor License Agreement](./legal/corporate-contributor-license-agreement.md).
- By submitting code contributions as an individual or on behalf of a
  corporation to any directory in this repository outside of the
  [`ee/` directory](./ee), you agree to the
  [Developer Certificate of Origin](https://developercertificate.org/), and
  your contribution is licensed under the [MIT license](./LICENSE).

By contributing, you are deemed to have accepted the agreement that applies
to your contribution. There is nothing separate to sign. You keep ownership
of your contribution; you grant Different AI, Inc. the permissions in the
applicable agreement, and those permissions cannot be withdrawn.

`ee/` needs a CLA rather than the DCO because the code there is distributed
under the [OpenWork EE License](./ee/LICENSE), not an open source license,
and each released version later converts to MIT. The CLA grants a license
broad enough to do both.

To put an overarching Corporate CLA in place for everyone contributing on
behalf of your organization, email team@openworklabs.com.

_This notice should stay as the first item in this file._

## Signing off commits

Sign off every commit to record your DCO certification in the history:

```
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <your@email>` trailer. Pull requests
with unsigned commits cannot be merged: the `contributor-pr-required` check
fails and a comment on the pull request explains the fix
(`git rebase --signoff origin/dev`, then force-push).

## How CI runs on a pull request from a fork

On every push, in this order:

1. **Contributor screen.** Before any of your code runs, an automated screen
   reads your changes. It blocks hidden or malformed characters (invisible
   Unicode, bidirectional overrides, look-alike letters, invalid UTF-8),
   which you must remove. It holds for a maintainer: dependency or lockfile
   changes, database schema or migration changes, binary files, code that
   looks encoded or obfuscated, and text that tries to give instructions to
   an AI reviewer. A comment on the pull request lists
   what it found.
2. **Tests and security review.** If the screen is clean, the tests and the
   Warden security review start automatically. They run without access to
   any secrets.
3. **Maintainer review.** A maintainer reviews your changes and comments
   `/test`. That marks the commit they reviewed (it also starts the tests if
   the screen held them). `contributor-pr-required` passes once the tests
   pass and Warden is clear on that commit. If you push again, the screen
   runs again and a maintainer reviews the new commits.

Changes to CI or agent configuration (`.github/`, `.opencode/`,
`opencode.json`, `warden.toml`, `.warden/`, agent skills) can't be tested
from a fork. A maintainer moves those commits to a branch in this
repository, keeping you as the author.

## Paid work

If you are contributing as part of paid work, a work trial, or on behalf of
an employer, make sure a signed agreement covering intellectual property
assignment is in place with Different AI, Inc. **before** your first pull
request — ask your contact at OpenWork if you are unsure. Maintainers will
not merge substantive contributions from paid engagements without one.

## Practical notes

- Use pnpm, never npm or yarn.
- Keep diffs as small as possible; propose the simpler solution.
- Runtime-observable changes need test evidence on the PR (see `AGENTS.md`).
- Never commit secrets, credentials, or personal data.
