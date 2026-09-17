# OpenAI-compatible system-message ordering

## Outcome

OpenWork now installs a final system-prompt transform after its managed runtime plugins. For models whose engine adapter is exactly `@ai-sdk/openai-compatible`, that transform folds every system-hook contribution into one ordered string before the engine emits wire messages. It does not rewrite conversation messages or providers using other adapters.

The strict request-path witness rejects any request containing `role: "system"` at an index greater than zero. It exercises the managed OpenWork server, the pinned OpenCode engine, a real OpenAI-compatible provider request, project `AGENTS.md`, the local skill catalog, a per-turn system instruction, two separate runtime-plugin system entries, and a user message. The fixed request reaches the witness with one system message at index zero and the user message still at user priority.

## Root cause and exact emitter

OpenWork pins OpenCode v1.18.30 in `constants.json:2`. Desktop packaging resolves the release repository and pinned version in `apps/desktop/scripts/prepare-sidecar.mjs:35-57`, constructs the release asset URL at `apps/desktop/scripts/prepare-sidecar.mjs:223-244`, and copies the downloaded binary at `apps/desktop/scripts/prepare-sidecar.mjs:250-334`. The engine source is therefore not vendored or patchable through this repository's `patches/` directory.

In pinned OpenCode commit `3104c1428ec91f809e5ab86631300de41eb6952e`, the normal chat path gathers environment, project instructions, MCP instructions, and skills as system-prefix inputs in `packages/opencode/src/session/prompt.ts:1257-1271`. `packages/opencode/src/session/llm/request.ts:58-66` joins the agent prompt, those inputs, and `input.user.system` into the first system entry, then runs every `experimental.chat.system.transform` hook at lines 68-73.

The exact post-index-zero emitter is `packages/opencode/src/session/llm/request.ts:101-112`: every entry remaining in the hook-mutated `system` array becomes a separate wire `role: "system"` message before conversation messages. The attempted guard at lines 74-78 runs only when the array has more than two entries **and** `system[0]` still equals the pre-hook header. OpenWork's existing in-place prompt composition intentionally changes `system[0]`, so that guard does not run; each later runtime-plugin entry is emitted independently. Even without that mutation, the guard preserves the original header as its own entry and can reduce the array only to two, never one.

OpenWork's own prompt hooks are not current emitters. `apps/server/src/opencode-plugins/agent-instruction-compose.ts:78-99` extends the existing entry; the capabilities, extensions, and spreadsheet hooks call it at `apps/server/src/opencode-plugins/openwork-capabilities-knowledge.ts:213-216`, `apps/server/src/opencode-plugins/openwork-extensions-preview.ts:1340-1372`, and `apps/server/src/opencode-plugins/openwork-spreadsheets.ts:241-248`. Managed runtime plugins execute after those hooks and could still append entries.

## Fix

- `apps/server/src/opencode-plugins/openwork-openai-compatible-system.ts:1-34` recognizes only `model.api.npm === "@ai-sdk/openai-compatible"`, preserves system-array order, and replaces multiple entries with one blank-line-separated entry.
- `apps/server/src/openwork-runtime-config.ts:95-114` registers the normalizer after every OpenWork-managed runtime plugin.
- `apps/server/src/openwork-extensions-plugin-path.ts` exposes its source/packaged path, and `apps/server/package.json` includes it in packaged plugin builds.
- The transform sees only the system-hook array. It never reads, moves, or promotes user/assistant/tool messages; the strict witness asserts that the user marker remains only in a user message.

## AGENTS, skills, per-turn prompts, and summaries

- Project/global instruction files are read by pinned OpenCode `packages/opencode/src/session/instruction.ts:110-168` and enter the first system prefix through `prompt.ts:1257-1269`.
- The skill catalog is assembled by `packages/opencode/src/session/system.ts:107-119` and enters that same prefix. Skill bodies loaded later by tools remain tool/user-visible context, not new system roles.
- Per-turn `user.system` is joined into the first entry by `llm/request.ts:58-66`; the fix does not elevate ordinary conversation content.
- Automatic titles call the same LLM preparation path with `system: []` at `packages/opencode/src/session/prompt.ts:193-236`. Compaction summaries call the same processor with `system: []` at `packages/opencode/src/session/compaction.ts:425-447`. Main turns, titles, and summaries therefore receive the same final transform.
- Agent-definition generation also invokes `experimental.chat.system.transform` before mapping entries to wire messages at `packages/opencode/src/agent/agent.ts:380-405`, so the plugin applies there when the selected adapter is OpenAI-compatible.

## Hosted gateway relevance

The hosted gateway classifies `@ai-sdk/openai-compatible` as `openai_compatible` in `ee/apps/gateway/src/protocols.ts:20-25` and treats chat-completions paths as OpenAI chat at lines 60-70. It does not originate the duplicate prefix: requests already contain their `messages` array before gateway forwarding. Desktop/cloud-provider configurations using the OpenAI-compatible adapter benefit before the request reaches the gateway; external gateway clients that do not use the OpenWork managed engine do not.

## Proof

- Unit and runtime-config tests: `pnpm --filter openwork-server exec bun --conditions=development test src/opencode-plugins/openwork-openai-compatible-system.test.ts src/openwork-runtime-config.test.ts` — 17 passed, 0 failed.
- Agent-first request-path test (Daytona lane): `OPENWORK_EVAL_DAYTONA=1 pnpm evals:pr specs/openai-compatible-system-order.test.ts` — 1 passed, 0 failed, 0 skipped.
- Server checks: `pnpm --filter openwork-server typecheck` and `pnpm --filter openwork-server build` — both exited 0; the build emitted the new packaged plugin.
- Revert control: removing the final normalizer registration and running `OPENWORK_EVAL_DAYTONA=1 pnpm evals:pr specs/openai-compatible-system-order.test.ts` exited 1 because the observed system indexes were `[0, 1, 2]`; restoring the registration returned the same command to 1 passed, 0 failed, 0 skipped.
- Full evals typecheck is pre-existing red: `pnpm --dir evals typecheck` exited 1 with 28 errors on both this worktree and a clean `6f443f351` control. The first error in both was missing the `node` type definition; the new spec and world produced no reported type error, and the focused Vitest compilation passed.

## Exclusions and caveats

- The transform intentionally does not change `@ai-sdk/openai`, Azure, Anthropic, OpenRouter, or other adapters. Their provider semantics and caching boundaries are unchanged.
- The OpenCode v2 preview is a separate binary/configuration path and is not covered by this v1 fix or witness.
- A project-local plugin loaded by OpenCode after the server-owned `OPENCODE_CONFIG` can still append a later system entry after this finalizer. A complete engine-wide guarantee requires an upstream OpenCode change at the final message-mapping boundary. No upstream issue was filed; filing one requires explicit approval.
- Direct callers of the hosted gateway and independently managed OpenCode processes are outside this change.
