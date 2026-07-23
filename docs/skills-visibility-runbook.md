# Runbook: my agent does not see my skill

First identify which independent skill path is failing.

| | Local / hub-installed | OpenWork Connect remote |
|---|---|---|
| Source | A local `SKILL.md` | Account/org catalog `skill://index.json` |
| Discovery owner | OpenCode native `Skill` service | OpenWork server Connect catalog |
| Prompt owner | OpenCode native system assembly | OpenWork contributor `connect-skills` |
| Execution | Native skill loader/tool | `openwork-cloud_execute_capability` |
| Local file expected | Yes | No |

Remote skills intentionally do not become local files or native `/skill`
entries. Local skills intentionally do not appear in OpenWork's remote
`<available_skills>` block.

## Fast trace

1. Enable desktop Developer Mode. This enables metadata, not prompt text.
2. Send one message and copy `trace=<id>` from
   `observed system array changed`.
3. Filter logs by that trace and find `id=connect-skills` plus the preceding
   `connect-context` candidate/cache/MCP-phase records.
4. Inspect the same passive bundle without another chat turn:

   ```sh
   curl -H "Authorization: Bearer <client-token>" \
     "<server>/experimental/connect/context?directory=<url-encoded-directory>"
   ```

5. Read `skills.count`, `skills.instruction`, and `diagnostics`. The prompt
   plugin uses this one versioned route; it does not make a second
   `/experimental/connect/state` request.
6. Only if hashes are insufficient, separately enable **Exact prepared-prompt
   tracing**, apply the idle restart, and send another message. Confirm the
   exact block and `match=text-correspondence causalOrigin=unproven` row.
7. Revoke exact tracing and restart when finished.

## Remote Connect chain

The complete remote chain is:

account/org assignment → passive local candidate discovery → bounded MCP
initialize → `skill://index.json` → discovery-schema validation → bounded
`<available_skills>` rendering → context bundle → `connect-skills` contributor
→ post-system-hooks `system[]` → live `openwork-cloud` execution tools.

Candidate diagnostics contain only safe fields:

- `source=server|workspace` and `candidateHash=<12 hex>` identify the source;
- `phase=configuration|initialize|initialized-notification|resources-read|schema|session-close` identifies the boundary;
- `httpStatus` or `jsonRpcCode` identifies protocol failure without copying the
  URL, response body, headers, or error message;
- `cache=miss|hit|stale hit; refresh scheduled` explains a reused decision.

Catalog reads never promote a legacy workspace candidate or mutate local
configuration. Four deduplicated candidates share a five-second deadline;
successful sessions are closed best-effort. A stale value can be served for at
most five minutes while one background refresh runs.

### Remote diagnosis

| Evidence | Meaning / action |
|---|---|
| Bundle `configuration` failure | Managed server URL/token is missing; confirm OpenWork launched this engine |
| Bundle `auth status=401|403` | Loopback credentials drifted; restart the managed workspace |
| `phase=configuration ... invalid-url|disabled` | Re-provision or re-enable Connect |
| `phase=initialize ... httpStatus|jsonRpcCode` | Endpoint/auth/MCP initialization failed; reconnect the identified candidate |
| `phase=initialized-notification ... failed` | MCP session setup was rejected after initialize |
| `phase=resources-read ... missing-result|missing-contents|missing-index-text` | The endpoint does not publish the expected resource shape |
| `phase=schema ... invalid-schema` | Compare the remote index with discovery schema 0.2.0 |
| `skills=0` with a selected schema | Catalog is valid but authorization/filtering returned no skills |
| `id=connect-skills chars=<n> sha256=<64 hex>` | OpenWork appended a remote skill block |
| Metadata array hash changed | Prepared context changed; use per-block delta to locate it |
| Exact text-correspondence span present | The recorded OpenWork text occurs at that final span; causal owner is still unproven |
| `mcp-status ... status=failed failureClass=...` | The named engine MCP failed; use class to choose auth, timeout, transport, or protocol triage |

A visible remote descriptor does not prove its content can execute. The later
capability fetch can still return `content_not_synced`, membership/grant errors,
or a live tool-registration failure. Run
`POST /workspace/:id/diagnostics/agent-context` to separate recorded delivery,
engine MCP status, provider tool projection, and bounded direct Cloud evidence.

## Local / hub-installed chain

For pinned OpenCode v1.17.11, the likely injection sequence is:

1. `packages/opencode/src/skill/index.ts` discovers configured project/global
   roots and builds the instance skill map.
2. Duplicate names resolve in the native map; a later concurrent root result
   can replace an earlier one.
3. Agent permission filtering removes denied skills.
4. `Skill.fmt` renders the native `<available_skills>` content.
5. `packages/opencode/src/session/system.ts` adds the native skill instruction.
6. `packages/opencode/src/session/prompt.ts` appends environment, instruction,
   and MCP-derived system context.
7. `packages/opencode/src/session/llm/request.ts` joins agent/provider and
   `input.system`, then runs plugin system-transform hooks.

OpenWork remote skills join only at step 7 through `connect-skills`; they never
enter steps 1–4.

### Local checks

1. Verify `SKILL.md` exists in the intended root and has valid `name` and
   `description` frontmatter.
2. Verify Settings → Skills lists it. This proves OpenWork's filesystem scanner,
   not OpenCode's effective cached native registry.
3. Apply the required engine reload after install/update/remove. OpenCode caches
   native discovery for an instance; local skill writes now emit the `skills`
   reload trigger.
4. Compare OpenWork's list with OpenCode's effective `/skill` response. A
   scanner-only entry points to root, recursion, watcher, or cache drift.
5. Check duplicate names and permissions. Rename duplicates temporarily to make
   the winning path unambiguous.
6. In exact tracing, look for the native skill name/location in an unattributed
   final span. OpenWork can prove the final text exists, but cannot yet identify
   which native root won.

## Most likely skill-injection failure points

In priority order:

1. **Local scanner versus native cache:** Settings sees a file but OpenCode's
   instance `/skill` map is stale or uses different roots/recursion rules.
2. **Duplicate native name:** two roots publish the same name and the unexpected
   path wins.
3. **Native permission filter:** discovery succeeds but the active agent removes
   the skill before `Skill.fmt`.
4. **Remote account/org filtering:** active membership, grant, link, policy, or
   marketplace assignment filters the catalog to empty before OpenWork sees it.
5. **Remote descriptor/content split:** the descriptor is injected but full
   `SKILL.md` retrieval is not synchronized or no longer authorized.
6. **Host/workspace identity drift:** the account-scoped catalog is valid but the
   workspace engine uses a different/stale Cloud MCP registration.
7. **UI versus prompt cache drift:** the marketplace UI and 30-second prompt
   catalog refresh independently.
8. **Prompt safety caps:** more than 100 skills or 32,000 rendered characters are
   deliberately truncated.
9. **Transport differences:** server-side catalog fetch and engine-side MCP can
   see different TLS, proxy, or credential conditions.

The highest-value follow-up is a bounded comparison of OpenWork's local scanner
with OpenCode's effective `/skill` result, including native winning path/root,
duplicate/shadow state, and permission exclusion. The clean upstream OpenCode
seam would add a request-scoped prepared-prompt event with origin-tagged
components plus a native skill-discovery snapshot. Without that seam, no plugin
can truthfully provide causal origin for every final array span.
