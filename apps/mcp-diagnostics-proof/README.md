# MCP diagnostics proof viewer

This private React app turns the independent MCP diagnostics rehearsal into an
eight-chapter managerial story. It is an explanation layer over captured
evidence, not a replacement for the product flow and not a release approval.

Current status remains explicit in the UI:

- Agent verified: Passed
- Jalil verification: Not started
- Controlled parent: None integrated

## Start the viewer

From the rehearsal worktree:

```bash
pnpm dev:mcp-diagnostics-proof
```

Open <http://127.0.0.1:3334>. Use the chapter rail, Previous/Next buttons, URL
hashes, or the left and right arrow keys to move through the story. Each chapter
also has a local “I reviewed” checkpoint. That checklist stays in the browser;
it deliberately does not change the PR or release-verification status.

From the private hub root, the isolated equivalent is:

```bash
./bin/openwork-hub run mcp mcp-diagnostics-integration-rehearsal -- \
  pnpm dev:mcp-diagnostics-proof
```

## Evidence provenance

The nine PNGs under `src/assets/evidence/` come from canonical product replay
`2026-07-11T21-25-52-239Z`:

- 1 passed / 0 failed / 0 skipped
- 8 operational chapters
- 66 assertions
- 9 validated screenshots

The replay source remains under
`evals/flows/mcp-diagnostics-integration-rehearsal.flow.mjs`; generated results
remain ignored under `evals/results/`. The checked-in images give this viewer a
stable, offline review record.

Step 6 has an important evidence boundary. Its screenshot shows that the
connection remains Connected and its protocol/catalog result remains ready.
The adjacent machine assertions—not visible denial text in the screenshot—are
the evidence for `provider_policy_denied`, `PROVIDER_AUTHORIZATION`, and
`provider_admin` ownership.

## Validate the viewer

```bash
pnpm --filter @openwork/mcp-diagnostics-proof test
pnpm --filter @openwork/mcp-diagnostics-proof typecheck
pnpm --filter @openwork/mcp-diagnostics-proof build
```

The evidence test verifies eight chapters, nine unique valid PNGs, canonical
run metadata, controlled-release status, the Step 6 evidence boundary, and the
absence of synthetic credential values.

To capture Fraimz proof of the viewer itself, start it and a Chrome CDP target,
then run:

```bash
MCP_DIAGNOSTICS_PROOF_URL=http://127.0.0.1:3334 \
  pnpm fraimz --flow mcp-diagnostics-proof-app \
  --cdp-url <chrome-cdp-url>
```

The final viewer replay is `2026-07-11T22-59-33-547Z`: one passed flow,
zero failures or skips, 24 assertions, and four proof-viewer screenshots. It
checks the release boundary, every chapter and evidence image, the honest Step
6 screenshot/API split, skip-link focus, keyboard navigation, and the 390 px
no-overflow cleanup layout.
Manual browser review additionally covers the full-size image dialog, local
review persistence/reset, console output, and a 390 px no-overflow breakpoint.

To replay the underlying product journey, use the isolated Den and fixture
instructions in the hub playbook, then run:

```bash
MCP_MOCK_DIAGNOSTICS_KEY=rehearsal-key \
  pnpm fraimz --flow mcp-diagnostics-integration-rehearsal \
  --cdp-url <chrome-cdp-url>
```

## Scope

This viewer proves that the captured local rehearsal can be understood and
inspected chapter by chapter. The focused mock suite covers the ServiceNow,
Microsoft Work IQ, and Agent 365 enterprise-shaped profiles; the visual tour
uses the ServiceNow-style scenario so it stays understandable. It does not
claim live Microsoft 365 or ServiceNow tenant conformance, provider mutation
success, approval by Jalil, or integration into the controlled release parent.
