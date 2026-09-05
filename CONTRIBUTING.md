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
may submit it under this repository's licenses. Pull requests with unsigned
commits cannot be merged.

## 2. How your contribution is licensed

This repository is open core, and the paperwork depends on where you
contribute (the same structure GitLab uses for its `ee/` directory):

- Contributions to code **outside `ee/`** are accepted under the
  [MIT license](./LICENSE) (inbound = outbound), certified by your DCO
  sign-off.
- Contributions to code **under `ee/`** additionally require a Contributor
  License Agreement, because the EE-licensed software is sold under
  subscriptions and each release later converts to MIT — we need a license
  from you broad enough to do both:
  - as an individual, the
    [Individual Contributor License Agreement](./legal/individual-contributor-license-agreement.md);
  - on behalf of a company, the
    [Corporate Contributor License Agreement](./legal/corporate-contributor-license-agreement.md).

  You keep ownership of your contribution; the CLA grants Different AI, Inc.
  a perpetual, irrevocable license (including sublicensing) that covers
  subscription distribution and the EE License's scheduled MIT conversion.

By submitting a pull request you agree your contribution is provided under
the terms above for the directories it modifies. Maintainers will not merge
`ee/` contributions until the applicable CLA is in place.

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
