---
name: build-a-witness
description: Mock a provider, add a mock, fake the API for tests. Use when building a deterministic provider witness for @openwork/testkit specs.
---

# Skill: Build a Witness

Follow the pattern established by `@openwork/labs` (`evals/packages/labs/src/mock-mcp.ts`) and the Google fixtures (`evals/packages/labs/src/mock-google.ts`).

## Witness contracts

- Attribute requests per identity using the credential. Key observations by
  `CREDENTIAL` token-ID fingerprints, never by global state.
- Expose since-ISO-scoped request logs so each assertion observes only its run.
- Negative queries return immediately. An empty mailbox must not consume its
  full timeout; slow negative assertions are the first assertions people
  delete.
- Consent and chooser pages must be programmatically drivable. Resolve only
  after the callback was actually served, never after a timer.
- A mock contributes environment to `server()` at boot. Its address is Den boot
  configuration; a mock started after Den is a mock Den ignores.
- On Daytona, publish the mock at a URL reachable by the remote Den with
  `exposeMock`.
