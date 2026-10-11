# Targeted native QA retest

Follow the [reported run](evidence/2026-10-10-native-qa-report.md), not a new
full-store submission. Preserve existing accounts/settings and use only the
approved synthetic workspace. No publication, purchase, policy change, real
outgoing action or cleanup is authorized by these instructions.

## 1. Codex: remove the test confounder before another model run

Use the same reported **0.162.0-alpha.17.2** binary, working directory and
isolated QA configuration context for every command. An installed package is
not proof of authentication or runtime server registration.

The alpha's source gives a manual/config MCP server higher precedence than a
plugin server with the same raw name, **including a disabled manual entry**.
Keeping `[mcp_servers.openwork] enabled = false` is therefore not a clean
plugin-only test. Do not enable it as a workaround: the manual source would
still win.

1. Obtain approval to use a fresh isolated QA context with **no manual server
   registration named `openwork` in any applicable configuration layer**.
   Preserve the old profile; do not alter required administrator policies. If a
   managed same-name entry cannot be avoided, mark the isolated test blocked.
2. Install/enable the exact package from PR #5850 and record its commit/version.
   Check installed file contents/cache against that package. Do not copy OAuth
   credentials from the successful direct profile.
3. Inspect installation without running a paid model turn:

   ```sh
   codex --version
   codex plugin marketplace list
   codex plugin list --marketplace openwork --json
   ```

4. In `/plugins`, confirm the local `openwork-connect` skill **and** bundled
   server `openwork`. If only the skill appears, inspect parse/cache warnings
   before OAuth. Do not guess that a `.codex-plugin` overlay is missing: this
   alpha supports the portable root format.
5. Inspect only safe effective server policy fields; do not expose configured
   headers or credential-store contents:

   ```sh
   codex mcp get openwork --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:d.get(k) for k in ("name","enabled","disabled_reason","enabled_tools","disabled_tools")}, indent=2))'
   ```

   Reference policy shape for this exact version:

   ```toml
   [plugins."openwork-connect@openwork"]
   enabled = true

   [plugins."openwork-connect@openwork".mcp_servers.openwork]
   enabled = true
   enabled_tools = ["list_skills", "get_skill"]
   ```

   Names are raw MCP names, not generated model-visible identifiers. A per-tool
   `enabled` field is not supported here. Check a denylist is not excluding both.
   Do not put transport or OAuth declarations in the plugin-policy object.
6. Inspect `/mcp verbose` and `/warnings`. Record only sanitized source,
   enabled/disabled status, first actionable startup/auth error and tool names.
   If the server is Ready with the readers, initial model declarations may be
   deferred behind native tool search—not a missing-server failure.
7. If needed and explicitly approved, use `codex mcp login openwork` or
   `/mcp login openwork` and complete normal OAuth for the **plugin-loaded**
   server. There is no `codex plugin login` command. `ON_INSTALL` in the catalog
   does not itself perform this CLI OAuth flow.
8. Only after inventory/auth are confirmed, run a bounded read-only fixture turn.
   Allow native tool search if needed to discover deferred MCP tools, but only
   the two approved MCP readers; no other gateway operations, local tools or
   mutations. Verify the result came from that bundled source, not a manual
   registration or model memory.

Do not add current docs' per-server `extensions.com.openai.auth` to this alpha's
portable `mcp.json`: its pinned parser rejects unknown server fields. No
manifest, transport or server-rename workaround is justified by the previous
run alone.

Pinned source: [`740e5af33c71225640e0c1c1555c514c2c93ab74`](https://github.com/openai/codex/tree/740e5af33c71225640e0c1c1555c514c2c93ab74),
especially `codex-mcp/src/catalog.rs`, `agent_plugin_config.rs`, `tools.rs`,
`core/src/mcp_tool_exposure.rs`, `core/config.schema.json` and
`cli/src/mcp_cmd.rs`.

## 2. Cursor: exact-name interpretation and ordinary usefulness

Load a fresh export of the updated PR #5850 package; record commit, version and
new ZIP hash. The old version 1.0.0 hash does not prove the changed guidance.
Preserve the unrelated baseline server and exactly one intended QA connection.
Use a **new chat** and make sure the packaged OpenWork skill is actually applied;
otherwise its instruction change was not exercised.

Run these separately:

- Positive: `Use my reviewer weekly brief to prepare this week's update without contacting any connected service.`
- Named negative: `Is the skill nonexistent-project-qa-404 available to me? Read it only if that exact requested skill is available.`
- Zero-overlap negative: `Is the skill nonexistent-zzunique-qa-404 available to me? Do not substitute another skill.`

The first negative deliberately shares the token `project` with the fixture.
Broad search may legitimately rank the fixture; that is not proof of identity.
Expect a fresh exact-reference verification and `unknown_skill`/unavailability,
not execution or relabeling of the brief as the requested item. A filtered list
may corroborate but is not an exact-name API. Offer alternatives only explicitly
as alternatives. Do not use a prior chat result to answer a new named lookup.

After the guided cases, repeat an ordinary unconstrained positive prompt. If it
stalls again, record time, visible activity, actual authorized tools and the
stopping point; do not compensate with a tool-specific prompt and call the
ordinary UX passed. Native success of the changed guidance remains unverified
until these retests.

## 3. Claude: validator and account prerequisites are separate

- Validate the directory package with **Claude Code 2.1.281+**. The `icon` field
  is a directory field ignored at runtime; older strict validators warn/fail.
  Record the 2.1.156 strict result accurately rather than removing listing
  metadata or claiming its installed plugin failed to load.
- Use an already eligible, approved account or permitted API setup; no purchase
  or billing enablement. Confirm a safe isolated workspace binding before using
  a connector matched to an existing one.
- Then test hosted and Code OAuth separately. Account/unknown-binding blockers
  are not auth failures, and the old default account/profile must remain intact.

## 4. Remaining shared security proof

Refresh, rejected use of an actually revoked server token and cross-workspace/
ungranted-item refusal all remain untested. Obtain the necessary approved second
QA workspace and normal revocation controls; do not inspect production tenant
IDs, tamper with token databases, change clocks or bypass consent. Reload/logout
UI evidence alone cannot pass these cases.

Deliver sanitized artifact links and the safe Codex diagnostics, with
Passed/Failed/Blocked/Not tested for each case. Bind new evidence to new package
commits and identify only test-created objects before requesting cleanup.
