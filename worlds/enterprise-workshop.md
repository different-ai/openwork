# Enterprise workshop

An internal, disposable fictional workplace. Jira and Confluence are backed by the same in-memory REST state as their MCP tools. Outlook and OneDrive are backed by an in-memory Microsoft Graph-shaped service. Writes are visible in the browser; mail never leaves the demo.

## Start

Local only; requires the same installed dependencies, MySQL and Redis as `acme-web`.

```sh
OPENAI_API_KEY="$(infisical secrets get OPENAI_API_KEY --env dev --plain --silent)" \
pnpm world up enterprise-workshop --stage rehearsal --detach --timeout 600000
```

For a nondefault local MySQL, scope `OPENWORK_EVAL_MYSQL_URL` to that command. Do not use a production database. The world creates a scratch database.

The real model defaults to `gpt-4.1`; add `-- --model <openai-model-id>` to choose another. Provider credentials go only to this world's encrypted Den provider storage, never to fixture files, snapshots, frontend source or mock services. The live model request incurs normal API costs. Service fixtures are synthetic.

Outputs give separate browser URLs for OpenWork, Jira, Confluence, Outlook and OneDrive. Sign into this world's Den using its fixture account; retrieve the masked password privately via `pnpm world outputs enterprise-workshop --stage rehearsal --reveal`. Select **Workshop OpenAI** in OpenWork. No model credentials appear in output.

## Rehearse a connected workday

`WORKSHOP.md` in the scratch workspace contains the brief. Start with:

> Read WORKSHOP.md. Find the customer's latest request in Outlook, read the Confluence datasheets for Atlas 2 and Atlas Lift, and draft a comparison. Save it in OneDrive and draft a reply with the document link. Don't send it yet.

Then:

1. Open Outlook: verify the customer's message and the saved reply draft.
2. Open OneDrive: find the created file, inspect and download it. Check generated Office files with an actual Office application; a valid extension is not proof.
3. Ask for a DOC ticket assigned to Nora Patel, titled “Update documentation for Project XYZ”. Open Jira and check assignee/title.
4. Ask for a Windows-login password-reset request. Verify the ITSD request, including its application field.
5. Ask for the office dog policy using internal documents only. The handbook contains no dog policy; no match is intentional.
6. Ask to update a Confluence page and add a review comment. Watch the browser view reflect the write.

The service pages are demo interfaces, not hosted Microsoft or Atlassian products. OneDrive previews are not full Word, Excel or PowerPoint editing. Use the existing Documents/Collabora engine for a future full editing integration rather than pretending a preview is Office.

## Isolation and reset

The seeded runtime uses a fresh temporary workspace **outside the checkout**, a separate home directory, and isolated OpenCode/OpenWork config, data, cache and credential stores. Only executable-path environment variables are forwarded; developer tokens, inline config, plugins and provider credentials are not inherited. Den/sandbox reuse overrides are refused. Startup verifies that every registered Den connection points to this world's owned mocks, issues a disposable MCP token through Den, reconciles the supported `openwork-cloud` endpoint and waits for the runtime configuration to show only that world's Den origin. No paid prompt is sent automatically.

One world per attendee or rehearsal keeps edits separate. The current setup is one signed-in demo person per world, not production multi-user authorization. Mock endpoints use synthetic authentication; they are trusted loopback test infrastructure, not publicly exposed services. Stop/restart the exact world to reset all service and workspace state.

```sh
pnpm world down enterprise-workshop --stage rehearsal
```

Supply the same local MySQL override on teardown if used at startup.

## Verification

```sh
pnpm --dir evals exec vitest run --config vitest.config.ts --project pr packages/labs/src/demo-atlassian.test.ts packages/labs/src/demo-microsoft365.test.ts
node --test evals/packages/labs/src/demo-workplace-ui.test.mjs
```

For parity against the real `mcp-atlassian`, set `DEMO_ATLASSIAN_PARITY=1` for the first command (requires `uvx`). No production service data is needed.

Isolation regressions:

```sh
node --test worlds/lib/acme-runtime.test.ts worlds/lib/workshop-verification.test.mjs
```

Explicit paid connected rehearsal (creates one DOC ticket, OneDrive text file and Outlook draft; never sends mail):

```sh
node worlds/lib/enterprise-workshop-probe.ts \
  evals/results/.worlds/scripts/enterprise-workshop--rehearsal.json
```

To re-check a completed paid session without repeating its writes, add `--verify-session <session-id> --marker <marker>` to the probe command. Its result clearly labels this as read-only verification rather than a new paid rehearsal.

The receipt is private local runtime state, not an evidence artifact. Do not commit or transfer it. The probe checks MCP origin isolation before prompting the app's default OpenWork agent. It requires a normally completed turn using the selected paid provider/model, both complete Confluence product reads, a DOC ticket structurally assigned to Nora, comparison content in OneDrive, and an unsent threaded reply to the latest Inbox update. Created IDs must appear in successful service tool outputs as well as backend state; discovery metadata or the user prompt cannot satisfy those assertions. A failed HTTP turn is aborted rather than left writing in the background.

Read-only, same-world browser evidence after the paid probe passes:

```sh
DEMO_SCREENSHOT_DIR=evals/results/enterprise-workshop/connected \
node worlds/lib/enterprise-workshop-browser-proof.mjs \
  evals/results/.worlds/scripts/enterprise-workshop--rehearsal.json \
  --session <session-id-from-probe> --marker <marker-from-probe>
```

This repeats the correlated backend/tool-trace assertions and verifies the real browser DOM before capturing Jira, Outlook, OneDrive, both Confluence datasheets and the app-web session at 1440×1000. The browser proof signs its disposable profile into the owned Den using the supported fixture handoff, and may sync runtime model preferences. It performs no new model turn or workplace-domain write. Service unit/browser tests alone do not prove a real-model run.
