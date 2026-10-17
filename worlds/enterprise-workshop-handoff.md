# Enterprise workshop handoff

## Latest full-narrative assessment — INCOMPLETE

The full twelve-scene paid comparison was executed on this Mac in **GPT-6.1 Sol FAST → Qwen3.8 27B** order against frozen implementation `be0acb54e9`. Both real tool-call preflights passed; both native runs used fresh owned worlds with matching initial business-state hashes and identical prompts/limits.

Frozen contract results: **Sol 8 PASS / 2 FAIL / 2 BLOCKED; Qwen 5 PASS / 5 FAIL / 2 BLOCKED**. These are bounded checks, not whole-workshop acceptance. The independent review additionally withholds acceptance for incompletely asserted one-pager requirements, reusable Workflow output semantics and digest delivery details. Actual feedback persistence and recipient-execution provenance remain blocked; Jira browser and Confluence verification checks failed. The aggregate comparison also exceeded its declared time threshold.

Read **`reports/workshop-narrative/README.md`**, `summary.json` and the reviewed screenshot gallery for the per-task matrix, costs/tokens/timing, exact models/tier, limitations and cleanup. Run `node evals/scripts/run-workshop-narrative.ts` with the owned local MySQL override to repeat; setup is documented in `worlds/workshop-narrative.md`. The proof/harness is opt-in and uses no production business connector or external mail send. Native worlds were disposed; only the read-only evidence preview may remain running.

The older scoped four-step success below is historical and must **not** be represented as an entire-narrative pass.

## Mac Studio continuation

Implementation checkpoint: `832dfa0244` on `feat/demo-atlassian-services` (pushed to `different-ai/openwork`, not merged). Work is isolated in a dedicated sibling worktree; the existing checkout and other worktrees were not changed. This is internal evaluation/demo tooling, not a production rollout or MCP App.

All fixture identities are fictional Acme Robotics data. Do not put actual customer/partner/person identities, credentials, runtime receipts or logs into this public repository.

## Implemented

- **Jira:** official product mark, project navigation and deep links, compact issue table, functional list/board views, filters/sorting, issue-type marks, avatars, detail layout, summary/description editing, safe rich-text rendering of Jira wiki headings/emphasis/lists/code, comments, status/priority/assignee changes.
- **Confluence:** official mark, space filtering, nested collapsible page tree, selected-page state, linked ancestors, real heading anchors, document typography/metadata, safe version-aware editing. Polling preserves drafts/focus and last-known content offline.
- **Outlook:** app rail, folder counts, sender-focused list, reading pane/command bar, archive/delete/restore/read-state controls, filtering/search, compose/drafts/replies and calendar. Added an MCP `mail_create_reply_draft` operation that preserves the source conversation and recipients; it does not send.
- **OneDrive:** file table, metadata sorting, folders, upload/download, preview pane, text editing and stale-eTag protection. Office downloads are real OOXML; browser previews are explicitly read-only extracted text, **not** Word/Excel/PowerPoint editing.
- Every mutation uses the same in-memory backend as connected tools. Unsupported product features are omitted rather than displayed as dead controls. No screenshot is used to fake a UI.

Official references and DESIGN rule mappings: `worlds/atlassian-ui-references.md` and `worlds/microsoft365-ui-references.md`.

## Isolation fixed and cold-booted locally

`worlds/lib/acme-runtime.ts` creates a workspace outside the checkout plus separate home/config/data/cache/credential stores. Both runtime children and Den/build children are stripped of ambient developer credentials, inline config, plugins and `NODE_OPTIONS`; only executable settings, world lifecycle metadata and the explicit local MySQL override survive. The paid OpenAI key is removed from the process environment before any service starts and is stored only in the disposable Den provider.

Den/sandbox reuse overrides are refused. Startup verifies all Den MCP connections against the exact owned mock origins, obtains a disposable token using the supported Den token route, reconciles `openwork-cloud`, and waits for the asynchronously rolled engine to expose only the owned Den origin. Disabled foreign MCP entries also fail the check. No paid prompt is sent during startup.

Do not restore the old `<repo>/tmp/worlds/.../workspace` layout: it inherited source-checkout plugins/config and previously queried production metadata. The original-host attempt made no external writes; no original receipts, credentials, logs or database state were transferred.

## Verification on this Mac

At implementation checkpoint `832dfa0244`, all the following exited 0:

```sh
DEMO_ATLASSIAN_PARITY=1 pnpm --dir evals exec vitest run --config vitest.config.ts --project pr packages/labs/src/demo-atlassian.test.ts packages/labs/src/demo-microsoft365.test.ts
# 25 passed: 10 Atlassian (real-server parity included), 15 Microsoft 365; zero skips

DEMO_SCREENSHOT_DIR=evals/results/enterprise-workshop/atlassian \
  node --test evals/packages/labs/src/demo-workplace-ui.test.mjs
# 2 passed, zero skips; actual headless Chrome

DEMO_SCREENSHOT_DIR=evals/results/enterprise-workshop/microsoft365 \
  node --test evals/packages/labs/src/demo-microsoft365-ui.test.mjs
# 1 passed, zero skips; actual headless Chrome

node --test worlds/lib/acme-runtime.test.ts worlds/lib/workshop-verification.test.mjs
# 4 passed, zero skips

pnpm --dir evals typecheck
# 257 eval source files; no errors
```

The parity harness pins **mcp-atlassian 0.23.1 + FastMCP 3.4.9**. The `3.4.9` reported by its handshake is FastMCP's version, not the PyPI mcp-atlassian version. A mistaken initial pin timed out; it was corrected and child-exit/request-timeout handling was added. An initial Microsoft schema-count assertion was updated for the new reply tool; the final full suite passed.

Screenshots are real 1440×1000 browser captures under the ignored `evals/results/enterprise-workshop/` directory (nine Atlassian and seven Microsoft screenshots). They are not committed. Browser proofs include shared REST/MCP writes, polling/focus continuity, offline state, sanitization, stale writes and real file uploads/downloads.

## Connected paid rehearsal — status

**Passed for the scoped core flow on a fresh Mac cold boot:** real `gpt-4.1`, the default OpenWork agent (not `build`), complete connected reads of both Confluence datasheets, DOC ticket assigned to Nora, OneDrive comparison content, and a threaded Outlook reply draft linking that document. No mail was sent. Created IDs were correlated with successful tool outputs and independently checked against backend state. The same-world headless-browser proof passed for all six surfaces/captures, including the signed-in app-web session with GPT-4.1 selected. A final read-only verification after browser sign-in again passed MCP-origin and workflow checks.

This is a scoped connected-workflow verdict, not a claim that every possible workshop narrative or Office/Windows flow passes. Startup and unit tests alone were not used as the end-to-end verdict.

The default OpenWork agent (not a build-agent substitute) now runs with only the local Den MCP endpoint. The first paid attempt stopped after guessing Jira's DOC key as a Confluence space; no writes occurred. The next attempt requested `/WORKSHOP.md` outside the workspace and stalled on file permission, eventually surfacing an HTTP 500 from the long-running proxy request. Those owned sessions were aborted. Headless UI inspection also identified a macOS `/var` versus `/private/var` alias mismatch: the engine canonicalized the workspace, so even the supplied absolute `/var/...` path looked external. The fixture now uses `realpath` and the paid probe checks session/workspace path equality before inference. A subsequent attempt performed a ticket/file write but incorrectly treated search excerpts and a literal-return script as source reads and could not discover Outlook tools; the strict verifier correctly rejected it. Microsoft tool metadata now explicitly names Outlook/OneDrive, and the fixture brief requires full-page reads and real threaded reply operations. Failed-world state was discarded, not presented as passing evidence. The probe aborts failed HTTP turns rather than leaving background writes running.

The strict shared verifier rejects prompt/discovery-only evidence, assistant errors/incomplete turns, wrong inference provider/model/agent, missing complete reads of both datasheets, a non-DOC or non-Nora ticket, missing comparison text, an unrelated/new-thread draft, and backend records not correlated with successful tool outputs. It also checks that the paid probe did not send mail. Outlook's search operation returns full Graph message bodies: that actual provider result is accepted as a complete read only when its latest-message ID and full body match the backend exactly. A snippet/bodyPreview does not pass; regression tests cover both cases. An initial verifier wrongly required a separate mail_read call even after a complete search read; correcting that assertion did not replay the successful writes. The final fresh paid rehearsal subsequently passed in its own right.

```sh
node worlds/lib/enterprise-workshop-probe.ts \
  evals/results/.worlds/scripts/enterprise-workshop--mac-rehearsal.json

DEMO_SCREENSHOT_DIR=evals/results/enterprise-workshop/connected \
node worlds/lib/enterprise-workshop-browser-proof.mjs \
  evals/results/.worlds/scripts/enterprise-workshop--mac-rehearsal.json \
  --session <paid-probe-session-id> --marker <paid-probe-marker>
```

The second command launches headless Chrome, never a focus-stealing desktop window. It performs no model turn or workplace-domain write; it signs the disposable browser profile into the owned Den using the supported fixture handoff and may sync runtime model preferences. It requires the actual completed paid session and captures the same-world Jira ticket, Outlook threaded unsent draft, OneDrive comparison, both Confluence datasheets and app-web session. Six final real captures and `browser-proof.json` are in `evals/results/enterprise-workshop/connected/`; `evals/results/enterprise-workshop/README.md` is the local screenshot gallery and preview handoff. Private receipts must never be published as evidence.

## Local operations and remaining limits

- Read `worlds/enterprise-workshop.md` for startup, narrative, reset and verification commands. The Mac uses the existing local Docker MySQL/Redis; each boot creates its own disposable database. Do not assume another host's credentials or attach a shared database.
- Infisical dev root `/` has the working `OPENAI_API_KEY`; fetch scoped to one command per `get-env-var`, never print it or inject every secret. Default paid model is `gpt-4.1`. Newer model families requiring Responses API are not validated here.
- Retrieve this world's masked fixture password privately with `pnpm world outputs enterprise-workshop --stage mac-rehearsal --reveal`. Do not paste that output into commits or evidence.
- Stop only the owned world with `pnpm world down enterprise-workshop --stage mac-rehearsal` using the same scoped local MySQL override if needed. Reboot resets mock state.
- Full Documents/Collabora editing, Windows/Office launching, a complete workshop attendee flow, and the extended password-reset/unknown-policy/update-Confluence narrative have **not** been established by the tests above.
- No claim of a globally clean worlds TypeScript build: the recorded typecheck is the evals package check.
