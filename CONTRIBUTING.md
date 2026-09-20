# Contributing to OpenWork

Thanks for contributing. Two things keep this project's licensing clean —
please read them before opening a pull request.

## 1. Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying the
[Developer Certificate of Origin v1.1](https://developercertificate.org/):

```
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <your@email>` trailer asserting that
you wrote the change (or otherwise have the right to submit it) and that you
may submit it under this repository's licenses. The final trailer block must
sign off the commit author's exact name and email and every `Co-authored-by`
identity. Pull requests with unsigned or mismatched commits cannot be merged.
The check is syntactic certification, not identity proof or a cryptographic
signature; checkboxes, labels, comments, and collaborator status do not replace
a valid trailer.

## 2. How your contribution is licensed

This repository is open core, and the applicable terms depend on where you
contribute:

- Contributions **outside `ee/`** are accepted under the licenses that already
  apply under the [root license](./LICENSE), generally MIT, certified by your
  DCO sign-off. Existing exceptions remain unchanged: third-party components
  keep their original licenses, and versions released under an earlier license
  remain under that license.
- Contributions with an old or new path **under `ee/`** additionally require a
  privately verified, applicable Contributor License Agreement (CLA):
  - as an individual, the
    [Individual Contributor License Agreement](./legal/individual-contributor-license-agreement.md);
  - on behalf of a company, the
    [Corporate Contributor License Agreement](./legal/corporate-contributor-license-agreement.md).

  You keep ownership of your contribution; the CLA grants Different AI, Inc.
  a perpetual, irrevocable license (including sublicensing) that covers
  subscription distribution and the EE License's scheduled MIT conversion.

By submitting a pull request you agree your contribution is provided under
the terms above for the directories it modifies. Maintainers will not merge
`ee/` contributions until the applicable CLA is privately verified. The
repository does not currently have an authorized CLA verifier, so the gate
holds every `ee/` addition, modification, deletion, or rename pending private
verification. Do not paste agreements or identity records into a pull request.

Commercial employment, contractor, work-trial, and other service arrangements
are separate from this repository contribution policy. They add no third gate
requirement here. The existing CLA terms, including the individual CLA's
representations about employer rights and authority, remain unchanged.

The `ee/LICENSE` client-side exception and per-version conversion to MIT after
two years also remain unchanged. CI does not interpret those exceptions to
bypass path-based CLA review. See
[the contribution policy](./legal/contribution-policy.md) for the fail-closed
process and administrator setup still required.

## Practical notes

- Use pnpm, never npm or yarn.
- Keep diffs as small as possible; propose the simpler solution.
- Runtime-observable changes need test evidence on the PR (see `AGENTS.md`).
- Never commit secrets, credentials, or personal data.
