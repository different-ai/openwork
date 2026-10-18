# Deeper client integrations

Research date: **2026-10-09**, for decisions on **2026-10-09/10**. This is a
research and implementation plan, not a support announcement or shipped feature.
Recheck the linked official contracts before implementing: these products are
changing quickly, and search-indexed excerpts can lag the live documentation.

## Decision and relationship to urgent listing

Keep three projects separate:

1. **Distribution:** people install OpenWork tools and a few useful workflows in
   a client they already use.
2. **Native client experience:** optional commands, specialists, modes, or panels
   make those workflows easier inside that client.
3. **Embedded execution:** OpenWork becomes the UI for another vendor's agent
   runtime. This changes execution, credentials, approvals, history, and support.

Sign in with ChatGPT (SIWC) is a fourth, orthogonal identity and inference-billing
integration. Installing an OpenWork plugin does not grant SIWC access, and SIWC
sign-in does not connect OpenWork's MCP gateway.

**None of the deeper integrations below is a prerequisite for the urgent
listing work.** The separate main track is documentation, packaging, readiness,
and submission for `https://api.openworklabs.com/mcp/agent`; its documentation,
packaging, and submission are **not finished by this PR**. This plan neither
replaces that work nor claims a package was published, a reviewer account was
provisioned, or a directory approved OpenWork. Listing-blocking authentication
or tool-exposure repairs belong to that track, not to an optional engine project.

Recommended order: ship small, explicit workflows over the existing gateway;
prove portable UI separately; add native conveniences only where they improve a
real task; consider local embedded runtimes last. Do not build a universal remote
runner, token-sharing backend, or cross-client hook framework to obtain a listing.

## Evidence and confidence

| Label | Meaning |
| --- | --- |
| **Official** | Stated in a fetched vendor/protocol document linked below; not a runtime test. |
| **Repo** | Observed in committed `origin/dev`, baseline `b439de76806015085503d260563d8294e08f4f15`; not proof that a production deployment enables it. |
| **Proposed** | A design or future PR; no implementation or flag declaration in this document change. |
| **Unverified** | Eligibility, a host/version combination, or end-to-end behavior still needs confirmation. |

No authenticated ChatGPT, Claude, Cowork, Cursor, ACP, mods, SDK, or SIWC journey
was run for this document. Public OAuth discovery observations from research are
not evidence of successful consent, refresh, execution, UI rendering, or catalog
approval. Existing specs are named as coverage to reuse, not claimed to have run.

### Committed OpenWork integration seams

Paths below are relative to this repository. Inspect them again at implementation
head rather than treating a Markdown plan as an API contract.

| Repo evidence | What exists and what it does not prove |
| --- | --- |
| [`apps/server/src/managed-opencode.ts`](../../apps/server/src/managed-opencode.ts), [`managed-opencode-v2.ts`](../../apps/server/src/managed-opencode-v2.ts), [`engine-pool.ts`](../../apps/server/src/engine-pool.ts) | Managed OpenCode processes, generated configuration, and existing rollover/lifecycle behavior. The V2 lane scopes config per instance and allowlists inherited environment keys. This is not a registry of arbitrary Codex/Claude/Cursor engines. |
| [`apps/app/src/app/lib/opencode-v2-adapter.ts`](../../apps/app/src/app/lib/opencode-v2-adapter.ts), [`opencode-session-native.ts`](../../apps/app/src/app/lib/opencode-session-native.ts) | UI code translates native OpenCode session, prompt, permission, and question shapes. Import compatibility is not semantic compatibility with another vendor's session protocol. |
| [`packages/headless-threads/src/types.ts`](../../packages/headless-threads/src/types.ts), [`README.md`](../../packages/headless-threads/README.md) | `AgentSessionClient` is a small create/send/snapshot/abort port. Only OpenCode implements it; engine ownership is `v1` or `v2`. This client adds no runtime or new store. It is a candidate seam, not a completed multi-engine abstraction. |
| [`packages/opencode-plugin/src/plugin.ts`](../../packages/opencode-plugin/src/plugin.ts), [`README.md`](../../packages/opencode-plugin/README.md) | Existing OpenCode V2 integration/device sign-in, provider and MCP transforms, account-scoped cached inventory, refresh, and cleanup. It does not register a general native session runner or implement SIWC. The README's tested version is historical repo evidence, not a test performed here. |
| [`ee/apps/den-api/src/mcp/agent.ts`](../../ee/apps/den-api/src/mcp/agent.ts), [`remote-session-capabilities.ts`](../../ee/apps/den-api/src/mcp/remote-session-capabilities.ts), [`apps/desktop/electron/automation-runner.mjs`](../../apps/desktop/electron/automation-runner.mjs) | Existing `remote-session:*` capabilities and desktop/cloud delivery drive native OpenWork/OpenCode sessions. Do not equate them with arbitrary external-runtime registration. |
| [`ee/apps/den-api/src/routes/org/plugin-system/github-discovery.ts`](../../ee/apps/den-api/src/routes/org/plugin-system/github-discovery.ts) | Imports recognize portable Agent Plugins and Claude-compatible component paths. Discovering a foreign component is not proof that OpenWork executes its hooks, mods, native UI, or client-specific policy. |
| [`ee/apps/den-api/src/mcp/app-builder-tools.ts`](../../ee/apps/den-api/src/mcp/app-builder-tools.ts), [`app-server.ts`](../../ee/apps/den-api/src/mcp/app-server.ts), [`scopes.ts`](../../ee/apps/den-api/src/mcp/scopes.ts) | Authored Apps have their own MCP endpoint and revision-bound tools/resources; the builder's launch envelope and first-party catalog are separate from the portable UI protocol. See the portability section below. |

The baseline contains **no committed** `packages/remote-sessions/`,
`packages/opencode-plugin/src/native-opencode.ts`, or
`apps/desktop/electron/session-runner-adapter.mjs`. Uncommitted native-runner work
in another checkout is not a dependency, an available API, or evidence of merged
support. If it later lands, review its contract and evidence before revising this
plan; do not copy a dirty checkout into an integration branch.

The current [OpenCode V2 client](https://opencode.ai/v2/docs/build/client) and
[plugin API](https://opencode.ai/v2/docs/build/plugins) support service clients,
transforms, events, commands, permissions, and RPC. Prefer those existing seams
for OpenCode-native improvements. Repo compatibility adapters must still be
checked against the runtime actually pinned by OpenWork.

## 1. OpenAI: native plugins, distribution, embedding, and SIWC

### Public catalog versus repository marketplaces

**Official:** OpenAI's [July 9, 2026 release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
replace the App Directory with the Plugin Directory. Current
[Apps SDK submission documentation](https://developers.openai.com/apps-sdk/deploy/submission)
says apps are now submitted and published as plugins. The
[plugin package guide](https://developers.openai.com/plugins/build/plugins) and
[submission guide](https://developers.openai.com/plugins/deploy/submission) are
the current contracts, not the original 2023 OpenAPI/`ai-plugin.json` program.

| Route | Components and distribution | OpenWork consequence |
| --- | --- | --- |
| Universal public Plugin Directory | One public catalog shared by ChatGPT and Codex; reviewed package with skills, remote MCP, and optional UI. Submission starts at [Platform Plugins](https://platform.openai.com/plugins). | Native skill workflows can accompany reviewed server tools. A standard MCP server does not need UI to qualify. Public review is not replaced by a GitHub marketplace. |
| Local/repo/personal Codex marketplace | `.agents/plugins/marketplace.json`; add a Git/local source with `codex plugin marketplace add`. CLI `/plugins` browses configured sources. | Good for opt-in testing and team distribution without claiming public-directory approval. Pin a release/ref and make uninstall leave unrelated client config intact. |
| Workspace plugins | Admin-controlled workspace publishing/import and access policy. | A private organization package stays inside that workspace; neither package sharing nor installation authorizes its external accounts. |

[Supported surfaces](https://developers.openai.com/codex/plugins): ChatGPT web,
desktop, and mobile can use eligible plugins; Codex in the ChatGPT desktop app
and Codex CLI support plugins. The IDE extension does **not** support plugin
bundles, but [direct MCP configuration](https://developers.openai.com/codex/mcp)
works across local Codex clients. A Desktop-only label is a real constraint, not
something a manifest can ignore.

New portable packages follow the [Agent Plugins authoring contract](https://agent-plugins.org/plugin-authors):
root `plugin.json`, `mcp.json`, `skills/`, and assets. The portable specification
does not standardize host installation policy, native UI, or marketplace access.
Put OpenAI-specific interface/onboarding/review settings in
`extensions.com.openai`. `.codex-plugin/plugin.json` and `.mcp.json` remain a
supported compatibility layout. Do not rely on automatic merging of both
metadata forms: OpenAI documents precedence, not a union of extensions.

**Native workflow first slice:** a read-oriented "Find the team's playbook"
skill, plus one explicit follow-up such as reading an assigned playbook. Prefer
a small packaged onboarding skill to broad instructions to manage every service.
Keep the runtime-resolved private organization skill catalog separate from the
public, reviewed skill snapshot.

### Public-review limits affect the shape, not the choice of engine

The [current guidelines](https://developers.openai.com/plugins/plugin-guidelines)
require each model-callable operation to be a separate reviewable tool with its
own schema and accurate metadata. They explicitly disallow discovery, operation
selection, or schema fetching plus a generic executor enabling operations not
individually exposed for review. They also reject plugins primarily acting as
unofficial third-party connectors/pass-through layers.

**Repo:** `search_capabilities` and `execute_capability` implement a generic
OpenWork gateway. **Assessment:** adding a skill or native package does not
remove that review risk. A curated public surface must not retain an unreviewed
execution escape hatch. Provider authorization and OpenWork-native value must be
explained; OpenAI acceptance of OpenWork's aggregator positioning is unverified.
Do not postpone necessary listing-safe exposure decisions into this deeper plan.

Public packages currently cannot include lifecycle hooks or existing registered
app references (`apps` / `.app.json`); remote endpoints are declared directly.
The submission portal currently connects only one MCP server per plugin. Its
OAuth/no-auth/mixed flow does not supply a generic API-key/bearer-header setup.
Keep reviewer passwords and OAuth client secrets outside the ZIP. Authenticated
review needs a fully configured demo account, sample data, no MFA/magic-link
step, five positive and three negative tests, and an accessible walkthrough.
Publisher verification, permissions, global-residency project restrictions,
domain verification, and approval remain work in the separate listing track.

Server-supplied skills can be imported through the documented draft skills
extension, but [Scan Tools imports static snapshots](https://developers.openai.com/plugins/build/mcp-server#import-skills-from-the-mcp-server),
not a user's evolving organization catalog. Current import limits include five
skills. Runtime OpenWork `list_skills`/`get_skill` tools are not automatically
that extension. Changes to imported skills require a new package version.

### OAuth and approvals

Use [MCP OAuth](https://developers.openai.com/plugins/build/auth), not a pasted
personal token: protected-resource discovery, authorization-code PKCE `S256`,
CIMD/DCR or a registered client, resource indicators, and issuer/audience/expiry/
scope validation. Follow the exact callback and client metadata document shown
for the connection. Callback-specific and stable redirect modes differ according
to correctly implemented issuer identification; do not hard-code one historical
ChatGPT callback for all clients. Codex loopback callbacks have their own
[registration rules](https://developers.openai.com/codex/mcp#oauth-client-registration-and-callbacks).

Every tool sets explicit `readOnlyHint`, `destructiveHint`, and `openWorldHint`.
Starting a workflow/job or persisting an artifact is not read-only. Private
workspace access is not automatically open-world simply because it uses HTTPS.
Annotations guide host UX; Den remains responsible for authorization and
consequential-action safeguards. Current guidelines say annotation justifications
are no longer required, while the submission-error/review references still
mention them: prepare explanations and confirm current portal enforcement rather
than asserting a resolved contract.

### App Server versus SDK: a different project

| Option | Official purpose | Proposed first slice |
| --- | --- | --- |
| [Codex App Server](https://developers.openai.com/codex/app-server) | Rich custom clients: authentication, conversations, streamed events, approvals, questions, history, and thread resume. | One explicitly selected local Codex-owned conversation, stdio child, API-key access initially, read-only task, visible cancellation. No silent replacement of the OpenCode engine. |
| [Codex SDK](https://developers.openai.com/codex/sdk) | Programmatic coding threads, CI, orchestration, or internal workflows; TypeScript and Python libraries. | A bounded specialist job with explicit inputs and output, not a second UI/session model disguised as a model provider. |

App Server is JSON-RPC-like but not MCP and not interchangeable with OpenCode's
HTTP API. Generate/pin the schema from the chosen runtime. WebSocket transport is
currently labeled experimental/unsupported; prefer local stdio. Handle pending
approvals, questions, terminal failures, token expiry, and shutdown—not just text
deltas. Start read-only and never auto-answer every approval request.

[Codex authentication](https://developers.openai.com/codex/auth) distinguishes
ChatGPT-managed sessions from usage-based API keys. App Server's external
`chatgptAuthTokens` mode is experimental and assumes the host already owns the
user's auth lifecycle; it is not permission to scrape a browser session or reuse
another application's token cache. Prefer documented login/API-key flows and
keep credentials outside transcripts and public packages.

### SIWC: open-source/local versus paid/remote eligibility

The [SIWC open-source overview](https://developers.openai.com/siwc/token-sharing-open-source)
explicitly covers open-source and locally hosted apps. Paid or remotely hosted
apps are directed to the [commercial partner interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
[Requesting a commercial client ID](https://developers.openai.com/siwc/request-client-id)
is a selected-partner/waitlist route. OpenWork's local open-source desktop and its
hosted/commercial service must be assessed separately; open-source licensing is
not proof that a remotely hosted paid offering qualifies. No OpenWork enrollment
or commercial approval is established here.

For the documented [open-source flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in):

- Start first registration with `client_id=dynamic_agent_client`; save the issued
  callback `client_id`, bound to the validated account/workspace, for subsequent
  sign-ins and code exchange. Never reuse another product's assigned client ID.
- Persist a stable opaque `ext_agent_host_id` per host, and use the app's actual
  name consistently as `agent_name_hint`. A host ID is not a credential.
- Use the system browser, state, nonce, PKCE `S256`, and a `127.0.0.1` loopback
  callback. Only its port can vary between attempts; host/path remain bound.
- Identity scopes are `openid profile email`. Optional plan access additionally
  needs `offline_access resource.invoke chatgpt.tokens.use.direct`, with
  `resource=https://api.openai.com/v1`. Check granted scopes, not just a valid
  ID token. Identity consent and inference consent are separate.
- Validate ID-token signature, issuer, audience, nonce, expiry, and selected
  account. Store/rotate credentials atomically, privately, and separately per
  account/registration. Do not copy tokens into Den, a plugin, or the engine's
  general configuration/cache. Sign-out and revocation need distinct handling.

[Inference requirements](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
use the public Responses API, `store: false`, `stream: true`, and an account-
specific model catalog. Completion is proved by `response.completed`, not by
seeing text or listing a model. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
exclude hosted MCP/connectors, `tool_search`, Code Interpreter, file search, and
native computer use on this route. HTTP callers supply history, not
`previous_response_id`; many ordinary Responses fields are unsupported.

Local shell/MCP execution in the client is different from hosted Responses
features. OpenCode provider/Code Mode compatibility must be tested against the
actual wire requests before claiming plan access works with the current engine.
The [documented Codex App Server SIWC setup](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
uses a Responses provider and token passed only to the child environment; renewal
requires process restart and thread resume in that setup. This is not the same as
App Server's experimental external ChatGPT token-login mode.

**Hold point:** no hosted token-sharing implementation, partner enrollment, or
billing fallback is authorized by this document. Never silently switch from plan
usage to an API key/credits when a quota or consent check fails.

## 2. Claude: chat, Cowork, Code, and native mods

### Component matrix

This table follows Anthropic's current
[platform support matrix](https://claude.com/docs/plugins/platform-support),
not old assumptions that plugins work only in Cowork or Code.

| Component | Claude chat: web/desktop/mobile | Cowork: desktop tasks | Claude Code: terminal/IDE/Code tab |
| --- | --- | --- | --- |
| Skills `skills/<name>/SKILL.md` | Load | Load | Load |
| Commands `commands/*.md` | Load as skills; matching/manual skill invocation | Namespaced `/plugin:command` | Load; namespaced commands/skills |
| Agents `agents/*.md` | Ignored | Load | Load |
| Settings hooks `hooks/hooks.json` | Ignored | Load | Load |
| Fixed-URL remote HTTP/SSE MCP | Listed on Connectors tab; add/connect required | Load; connect required | Load; authenticate/approve required |
| Local/stdio MCP, including `.mcpb` | Ignored | Loads when session runs on the user's computer | Loads |
| In-process JS/TS mod | Not a chat UI extension | Not a Cowork extension | Code-only; drawing varies by surface |
| `bin/` executables | Whole plugin cannot be installed | Whole plugin cannot be installed | Load |
| LSP, themes, output styles, settings | Ignored | Ignored | Load |

User-configured URLs/options have further limitations: chat ignores URL
`${user_config.*}` references; Cowork skips referenced options without defaults
rather than prompting. Prefer the fixed OpenWork URL and normal OAuth for the
first package.

[Account installs](https://claude.com/docs/plugins/overview) can sync from
claude.ai to Code; machine-only Code CLI installs do not sync back into the
account. Installation never completes connector authorization. Git marketplaces,
account/workspace sharing, and the reviewed public directory remain separate.
Use `.claude-plugin/plugin.json`, root component folders, and the documented MCP
configuration; keep each host-specific overlay explicit.

**First slice:** a playbook skill and one explicit report/inspect command.
Add one read-oriented specialist agent for Cowork/Code only if a user task needs
it. Do not ship lifecycle hooks or a mod in the baseline cross-surface package.
That avoids invisible execution in sessions where the user never invokes it.

### New native mods are real, but are privileged Code extensions

[Mods overview](https://code.claude.com/docs/en/plugins/mods/overview) and
[reference](https://code.claude.com/docs/en/plugins/mods/reference) verify JS/TS
functions running inside Claude Code. Current minimums documented in the overview
are terminal **v2.1.287+** and Desktop Code **v2.1.286+**. The reference describes
v2.1.290 plus version-specific additions; use declarations generated by the
installed build, not an assumed latest GitHub type file.

Verified entrypoints, for a **future** separate mod package:

- `.claude-plugin/plugin.json` identifies the plugin.
- `hooks/hooks.json` has `modules: ["./register.js"]` (or a supported TS module);
  paths are relative to that hooks file.
- The ES module exports `register(on, options)`. Event handlers receive
  `($, e, next)`; `e` is frozen, and changes are passed as copies to `next`.
- `tool.call`/`tool.check`, `prompt.submit`, turn/session events, and `ui.render`
  are actual documented events. `$.command.register`, `$.mcp.call`,
  `$.ui.open`, `$.ui.resolve`, and `$.ui.invalidate` are documented APIs.
- [UI](https://code.claude.com/docs/en/plugins/mods/interface) supports `Pane`,
  `AbovePrompt`, tool/transcript rows, and `Spinner`, with native elements such
  as `Box`, `Text`, `Button`, `Input`, and `Select`. These are **not** React DOM
  or an arbitrary HTML MCP Apps host. A permission prompt is not a render site.

| Code surface | Mod hooks | Mod drawing |
| --- | --- | --- |
| CLI/integrated terminal/JetBrains terminal | Run | Shown |
| Desktop Code local, non-WSL | Run | Shown, with element differences |
| Desktop Code WSL | No; plugins unavailable there | No |
| VS Code chat panel | Run | Not shown |
| `claude -p` / Agent SDK | Run when plugin is loaded | Not shown |
| Remote Control from web/mobile | Run on originating machine | Only on originating terminal |
| Cloud Code session | Run only if plugin reaches that environment | Not shown |

A useful mod first slice is an **explicitly opened, read-only OpenWork status
pane** using already authorized MCP tools, with a command/text fallback. Do not
start with prompt rewriting, request interception, approvals, model routing,
transcript access, or background task submission. Opening the pane must not
start a remote job, steal focus during typing, or export the conversation.

### Security scope is not an OAuth-like mod permission manifest

Anthropic's [mod administration guide](https://code.claude.com/docs/en/plugins/mods/admin)
is explicit: installed mods run as the user and **are not sandboxed**. A process
they start runs outside Claude's Bash sandbox. They can access files/secrets,
rewrite prompts/tool calls, and consume model usage. Narrow use of documented
APIs is our implementation restraint, not a host-enforced least-privilege grant.

The built-in guard normally loads for managed-settings machines or Team/
Enterprise users. It protects managed instructions/hooks/MCP metadata; where it
loads, deny rules and managed `PreToolUse` blocks take precedence over user mods,
subject to documented administrator options. These checks govern Claude's tool
calls, **not** a mod's own `$.fs`/`$.process` access. `$.http.fetch` honors certain
network policies; a spawned process can still reach the network as the user.
A GitHub plugin enabled by an admin is not automatically a privileged managed
policy mod: the documented managed tier requires an administrator-controlled
local directory and specific managed settings.

A user mod can override some ask/unmanaged-hook decisions. Our mod must never
approve on behalf of the human or present itself as Den's authorization layer.
Errors/timeouts can skip hooks, and worker failure can unload mods; a security
policy must not depend solely on our optional module remaining loaded. Use
server-side scope/grant checks and OS/network controls where appropriate.

Fallbacks: disable the mod plugin or use `--safe-mode`; platform settings such as
`disableAllHooks`/`allowManagedModsOnly` have broader effects and must not be
changed by an installer. A remotely controlled OpenWork feature flag can disable
our enhancements on the next verified check, but cannot undo a local file write
or guarantee removal of already installed code.

### Optional Agent SDK / ACP path

The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) is the
verified Python/TypeScript route for embedding Claude's agent in a process we
operate. It is a separate engine decision, not a way to render a plugin in chat.
Anthropic explicitly prohibits third-party products offering claude.ai login or
subscription rate limits unless previously approved. Start with approved API
credentials, explicit workspace isolation, and Commercial Terms review.

The [permission contract](https://code.claude.com/docs/en/agent-sdk/permissions)
requires care: `allowedTools` pre-approves tools; it is **not** a complete tool
allowlist, and `bypassPermissions` is not constrained by it. Auto-approved tools
can bypass `canUseTool`. Use a deliberately limited tool surface, explicit
permission mode, appropriate deny checks, and a real approval/question bridge.
Do not copy a quickstart that auto-accepts edits as our default. Plugins/mods that
load in an SDK session remain code with user/process privileges.

**ACP:** the [official ACP specification](https://agentclientprotocol.com/protocol/overview)
exists, but no native Anthropic ACP entrypoint was verified in the Claude Code
index or sources checked here. A third-party bridge is not an Anthropic contract.
Do not document `claude acp`, add an invented adapter dependency, or make ACP a
prerequisite. Reconsider only with a vendor-supported contract or an explicitly
reviewed third-party dependency decision.

## 3. Cursor: portable package, native overlay, and Custom Modes

The [plugin guide](https://cursor.com/docs/plugins) and
[reference](https://cursor.com/docs/reference/plugins) distinguish:

| Format | Manifest | Supported components |
| --- | --- | --- |
| Portable Agent Plugins | Root `plugin.json` declaring the standard schema | Skills and MCP servers |
| Native Cursor Plugins | `.cursor-plugin/plugin.json` | Skills, MCP, rules, agents, commands, hooks, variables |

Do not assume a Claude plugin manifest alone activates Cursor's native
components. Keep shared skills/MCP definitions as the portable source and produce
an explicit native overlay/package when needed. Cursor documents that it does
not expand portable `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` in `mcp.json`; its supported
`${CURSOR_PLUGIN_ROOT}` is a client-specific escape from that limitation. Avoid
local scripts and root variables in the first remote-only package.

Native discovery uses `rules/`, `agents/`, `commands/`, `skills/`,
`hooks/hooks.json`, and `mcp.json`. Explicit manifest paths replace default
folder discovery for that component. Local tests use
`~/.cursor/plugins/local/<plugin>` and Reload Window; organization local-import
policy can forbid them. Team marketplaces and public marketplace review are
separate, with installation policy separate from MCP authorization.

### Skills become modes through the UI, not a new manifest

[Skills](https://cursor.com/docs/skills) and
[Custom Modes](https://cursor.com/docs/agent/prompting#custom-modes) verify:

- `/skill-name` applies a skill to one message.
- Select a skill and **Option+Enter** on macOS / **Alt+Enter** on Windows, or
  **Use as Mode**, to keep it in context throughout the session.
- Modes are documented for Agents Window and CLI. Optional `icon`/`color` are
  skill frontmatter, not a `modes.json` file or a `modes` plugin manifest field.
- Skills in `.agents/skills/`, `.cursor/skills/`, or supported compatibility
  directories remain instruction packages, not new authorization domains.
- Personal `~/.cursor/skills/` sync to Cloud Agents is opt-in. Other home skill
  directories and machine config do not automatically travel to workers.

**First slice:** an OpenWork read-oriented operations/playbook skill usable as a
session mode, and an explicit one-shot command. Add a narrowly scoped `.mdc`
rule or specialist agent only where it improves discovery; no global instruction
that OpenWork outranks other tools. Do not conflate skill Custom Modes with ACP's
`agent`, `plan`, and `ask` runtime modes.

### Hooks are conveniences, not OpenWork security authority

[Cursor hooks](https://cursor.com/docs/hooks) are spawned JSON-over-stdio
scripts, not Claude's in-process mod API. Project/user/plugin/managed sources
have distinct scopes. A deny can block a supported local event, but the server
must still check every token, member, grant, and consequential write.

Important documented limits:

- Crash/timeout/nonzero failures can fail open by default; `failClosed` changes
  that for covered events. Invalid JSON/schema blocks permission events.
- `preToolUse` accepts `ask` syntactically but does **not** enforce it today;
  `subagentStart` treats `ask` as deny. Do not build consent around either case.
- Cloud command hooks start only after a writable environment exists. The cloud
  matrix excludes some lifecycle/MCP/Tab hooks; user home hooks are not there.
- Optional plugin hooks can be removed/disabled and do not govern alternate
  clients calling Den directly. Auto-retry/stop loops need bounds and must not
  replay writes or upload raw prompts/transcripts for telemetry.

Start with no hooks. If later justified, add one opt-in, redacted status
notification rather than a command interceptor or policy framework.

### MCP Apps and optional ACP

[Cursor MCP documentation](https://cursor.com/docs/mcp) explicitly supports MCP
Apps UI and progressive text fallback, OAuth, tools/resources/prompts, and
elicitation. That is an official support claim, **not** a runtime proof that
OpenWork's private launch hints work there. Test actual IDE/Agents Window
versions; do not infer terminal rendering from the IDE documentation.

The same page documents static OAuth callbacks for web/Agents and desktop. Use
the client's actual callback and discovered OpenWork resource; do not copy a
ChatGPT callback. Configuration, enterprise allowlisting, distribution, and tool
approval are different layers. Never embed a shared API key in the public repo.

Unlike Claude, [Cursor documents native ACP](https://cursor.com/docs/cli/acp):
`agent acp`, stdio JSON-RPC, `initialize`, `authenticate`, `session/new` or
capability-supported `session/load`, `session/prompt`, updates, permission
requests, and cancel. Handle permissions and blocking `cursor/ask_question` /
`cursor/create_plan`; do not copy the minimal sample's unconditional allow.
Project/user MCP configuration is supported; **team-level MCP is not supported in
ACP mode**. Resume capabilities, plugin/hook loading parity, model availability,
and MCP Apps rendering through an embedded ACP client remain unverified until
client tests. ACP negotiation is not a promise of Cursor IDE feature parity.

## 4. Portable MCP Apps: shared UI is not a universal launcher

The [MCP Apps specification/guide](https://modelcontextprotocol.io/docs/extensions/apps)
defines progressive enhancement around a model-visible tool, a `ui://` resource,
`_meta.ui.resourceUri`, `text/html;profile=mcp-app`, host capabilities, and the
UI bridge. A host authorizes and fetches resources from the connected server.
A tool result containing an HTML URL or arbitrary JSON does not install a server
or create a trusted rendering surface.

**Repo:** OpenWork's builder on `/mcp/agent` returns
`_meta["openwork/mcpApp"]` and a `structuredContent.launch` envelope. OpenWork's
own host resolves that against its private Connect catalog, then invokes the
App's own server at `/mcp/agent/connections/<appId>`. Code Mode may omit transport
`_meta`, which is why the structured envelope is also present. This adaptation
is **not** standardized across ChatGPT, Claude, Cursor, or a bare MCP client.

The standalone App server, by contrast, advertises `open_app` with a fixed
`_meta.ui.resourceUri`, exposes its bound tools and revision resources, and
returns a readable fallback. Its [proxy route](../../ee/apps/den-api/src/mcp/external-connection-proxy.ts)
verifies the agent OAuth resource, and its tools check ordinary read/write scopes
and Plugin/member access. That is a promising direct-connect route to test, not
proof that every host can discover/authorize/render it automatically.

The private host catalog requires both a host capability header and
`mcp:app-host`. [The scope definition](../../ee/apps/den-api/src/mcp/scopes.ts)
explicitly forbids advertising/granting that first-party scope through public
OAuth. **Keep it private.** Do not grant it to ChatGPT/Cursor/Claude, forward
first-party tokens, forge host headers, or turn a private catalog into a universal
launch protocol. Direct App endpoints still recheck ordinary caller access.
External-connection UI exposure also has its own `exposeDirectly`/grant policy;
a transport connection is not blanket visibility of every provider resource.

### Host behavior to prove separately

| Host | Official or repo evidence | Required fallback / remaining proof |
| --- | --- | --- |
| OpenWork desktop/web | Repo App host, sandbox, launch lifetime, resource cache, and frame code | Existing first-party path; test account switch, stale launch, removed grant, and flag off. |
| ChatGPT | [MCP Apps reference](https://developers.openai.com/plugins/reference) supports standard UI metadata plus optional OpenAI aliases | Connect the actual server/tool; test CSP, unique UI domain, approval and mobile. OpenWork launch JSON alone is insufficient. |
| Claude chat/desktop/mobile | [MCP Apps guide](https://claude.com/docs/connectors/building/mcp-apps/getting-started) and [mobile design rules](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines) | Claude requires its documented URL-derived `ui.domain`; mobile uses WebViews, lacks camera/mic/location, and needs prior web/desktop connector setup. Test Cowork separately. |
| Cursor IDE/Agents Window | Official MCP Apps support | Test standard resource/tool route and theme/input/approval behavior; no assumption of plugin/ACP/CLI rendering parity. |
| Claude Code terminal, Codex CLI/IDE, Cursor CLI, bare clients | Text/tool operation support; no portable HTML renderer verified for these terminal paths | Useful text/structured output and a safe user-openable destination. Claude's native mod pane is a different renderer, not HTML MCP Apps support. |

Claude Code's [MCP resource documentation](https://code.claude.com/docs/en/mcp)
explicitly distinguishes UI resources from model-readable context: UI resources
are omitted from ordinary resource suggestions/list results. Reading HTML by URI
is not rendering it. Likewise, a server advertising the UI extension cannot
force the host to implement it.

Portability also has real metadata differences: Claude documents a URL-hashed
`.claudemcpcontent.com` sandbox domain; OpenAI requires a unique plugin UI origin
for submission. Prefer SDK host-aware helpers and minimal host metadata only
where justified; do not guess the caller from a User-Agent or broaden every CSP
to make one host work. A rich result must retain a text fallback, and an
unsupported-UI host must not be told "the app is open".

## 5. Integration boundaries and proposed architecture

### Keep current execution as the default

Native plugin distribution should call the existing Den authority and OpenCode
sessions; it must not spawn a vendor engine just to read a playbook or display an
artifact. A native command is a convenience over an authorized capability, not a
replacement control plane. MCP is for tools **called by** a vendor agent; ACP /
App Server / Agent SDK are for **driving** an agent from our UI.

For any later embedded-engine decision:

1. Inventory actual dependencies in chat, automation, session history, browser,
   skills, attachment, permission, and question paths. The small
   `AgentSessionClient` port alone does not cover them all.
2. Add engine ownership to a separate, reviewed runtime contract. Store vendor
   thread/session IDs with engine and workspace provenance; never treat a Codex
   ID as an OpenCode session ID or rewrite existing history to claim portability.
3. Adapt streaming, cancellation, terminal failure, pending permission/question,
   usage, and resumability explicitly. Acceptance is not completion; a timed-out
   write must not be silently retried on a different engine.
4. Keep local filesystem/tools local. Remote execution and exporting local
   context are separate consent and implementation decisions, not consequences
   of choosing a vendor runtime.
5. Preserve the old engine for existing sessions. Select a different runtime
   only for a new/idle, explicitly selected conversation. Kill switches block
   new work, preserve history and pending state, and permit safe drain/stop.
6. Do not assume one vendor's model alias, plan entitlement, provider gateway,
   sandbox, permission pattern, or OAuth token is valid in another runtime.

### Current OpenWork scope and credential boundary

The committed [OAuth guide](../mcp-client-oauth.md) and
[MCP scope constants](../../ee/apps/den-api/src/mcp/scopes.ts) define ordinary
public `mcp:read`, `mcp:write`, and `offline_access` access. Use the exact discovered
`/mcp/agent` resource in both authorization and token requests; the web dashboard,
issuer, and metadata-document URLs are not the resource. An OAuth scope does not
replace current member/team/Plugin grants or downstream provider consent.

Read-only annotations and write-scope requirements are different axes. The
current [external dispatcher](../../ee/apps/den-api/src/mcp/external-capabilities.ts)
requires `mcp:write` even for a provider tool marked read-only; authored App
connection bindings inherit that rule. Do not promise a read-only demonstration
will work with a `mcp:read` token alone, or weaken dispatch authorization to make
an example pass. Request only scopes the tested workflow needs, expose a bounded
tool surface, and explain the actual requested access during consent. Provider
credentials remain in the existing per-member/shared connection layer; a native
plugin does not copy them into a host's settings.

### What stays private

- Organization/member credentials, OAuth refresh tokens, gateway keys, host-only
  tokens, demo passwords, tenant-specific catalog entries, grants, and logs.
- Private skill bodies and customer workflows unless their owner explicitly
  exports/shares them. Public packages contain generic authored examples only.
- Caller-private workflow receipts/results. Sharing a Plugin or native skill
  does not share another person's data or downstream account.
- Session transcripts and local paths beyond the explicit task input. No default
  hook/mod transcript upload, model-token copying, or background surveillance.
- Internal/admin routes and credential-management operations remain outside
  broadly exposed agent tools; use the existing [MCP exposure policy](../../ee/apps/den-api/src/mcp/README.md).

Revocation must be enforced by Den even if a user retains an old plugin, cached
skill, running mod, or custom client. Client instruction text, native hooks, and
UI hints are not entitlement checks. Installation and connect cards must never be
reported as a completed connection without a successful operation.

## 6. Ordered, independently reviewable implementation PRs

This is a **priority order**, not one combined rollout or a requirement to merge
every row. Client-native packages can proceed independently; engine/SIWC rows
need separate product/security approval. No registry, backend route, hook, engine,
or credential code is introduced by this documentation PR.

All keys below are **proposed, not declared**. Before user-visible feature code,
follow [add-a-feature](../../.opencode/skills/add-a-feature/SKILL.md): declare the
selected lowerCamelCase key in
[`packages/features/src/registry.ts`](../../packages/features/src/registry.ts),
`default: false`, deliberate deployments, then `pnpm features:sync` and include
Helm/API/SDK outputs. Never add an ad hoc `DEN_*_ENABLED` flag. Use the registry
resolver, `/admin` rollout/kill switch, and off-on-missing defaults. Deployment
means Den product (`cloud` / `self_hosted`), **not** where a child process runs.

Static packaging of existing capabilities may need no new registry key; it
must not silently add an executable behavior or backend surface. Every new
behavior proposed below needs its own off gate. A downloaded client package
cannot be remotely uninstalled by a Den flag: service access fails closed and
optional client enhancements degrade to the existing package/text path.

| PR | Smallest slice and product impact | Proposed gate / deployments | Off behavior and required proof |
| --- | --- | --- | --- |
| **1. Focused native workflow packs** | One generic read-oriented playbook workflow; OpenAI onboarding skill, Claude namespaced command, Cursor skill usable as a Custom Mode. Reuse listing-package conventions only after inspecting the separate work; do not edit or duplicate its in-progress artifacts. No hooks, model routing, or new tools. | None for package-only reuse; existing Den grants/Connect gate remain. If new activation behavior is added, first declare `nativeClientWorkflows`, `cloud` + `self_hosted`, off. | Disable/uninstall native pack; ordinary gateway/config remains. Validate package manifests, paths, no secrets, deterministic versioned builds, and one real supported-client workflow per package. Directory acceptance is separate evidence. |
| **2. Portable App conformance** | Prove one already authored read-only App through its own standard MCP endpoint in one external UI host, plus text-only client. Change only demonstrated metadata/auth/transport gaps, not the private catalog. | `portableClientApps`, `cloud` + `self_hosted`, off, if introducing new published behavior. Pure regression fixes need no invented rollout. | Text/structured fallback and explicit connect/open URL; retain OpenWork host flow. Prove CSP/origin isolation, per-member grants, wrong-resource refusal, stale revision, scope denial, and ordinary OAuth without app-host scope. |
| **3. Claude Code native status mod** | Separate opt-in Code-only package; explicit status command and read-only pane. Baseline skills/MCP package remains independent. No approval overrides or automatic remote job. | `claudeNativeClient`, `cloud` + `self_hosted`, off. Gate enhancements using verified feature state; absent/unreachable state disables them. | Pane/handlers stop cleanly; command gives text or baseline skill guidance. Run `claude plugin validate` and `claude plugin test`; inspect declared API calls. Prove terminal/Desktop drawing, non-drawing fallback, disabled/managed policy, timeout/reload, and no token/transcript leak. |
| **4. Cursor native overlay** | One explicit command and one narrowly scoped rule/agent only if they improve the workflow. Let the user select the skill as a mode. No hook in this first slice. | `cursorNativeClient`, `cloud` + `self_hosted`, off for additive service/UI behavior; package-only metadata needs no new key. | Portable skill/MCP continues to work; native convenience disabled. Prove local install, project versus user scope, blocked imports, Custom Mode enter/exit, and no edits to unrelated config. Test native package separately from portable format. |
| **5. Optional redacted client notifications** | Only if a concrete user need remains: one opt-in hook/mod status signal with a strict allowlist of fields, no raw prompts, commands, transcripts, token files, or automatic retry. Separate host-specific packages, not a universal policy hook. | `nativeClientNotifications`, `cloud` + `self_hosted`, off. Consent plus flag, neither substitutes for authorization. | No listener/extra network call when off; base workflow unchanged. Prove cloud/local hook matrix, timeout/failure behavior, bounded volume, explicit opt-out, and denial enforced even with hooks removed. |
| **6. Runtime-port decision and contract** | First a type/architecture PR over committed `AgentSessionClient`/UI seams: ownership, pending approvals/questions, event mapping, cancellation, and history semantics. No external runtime spawned. | No feature flag for type-only refactor. A generic runnable registry is new behavior and needs a separately scoped off feature before code. | Existing OpenCode behavior and storage unchanged. Contract/unit tests against V1/V2 fixtures and current native history; no speculative universal route family. Can proceed without native client packs or listing approval. |
| **7a. Local Codex App Server pilot** | One new read-only conversation using a local stdio Codex child and explicit API credentials. Do not replace provider selection or migrate OpenCode sessions. | `codexLocalSessions`, `cloud` + `self_hosted`, off; local-only execution even when Den is cloud. | Block new Codex sessions; safely stop/drain existing work and preserve its readable history. Offer OpenCode for a new conversation, never replay an uncertain operation automatically. Prove schema/runtime pin, approvals, questions, failed/incomplete turn, cancellation, restart/resume, isolated credentials, and off mid-turn. |
| **7b. Local Cursor ACP pilot (alternative)** | One local project, negotiated ACP, text-only session, real permission/plan/question answers. Use the official vendor entrypoint, not a community wrapper. Independent alternative to 7a. | `cursorLocalSessions`, `cloud` + `self_hosted`, off; local-only. | Same new-session/stop/history fallback as 7a. Prove capability negotiation, optional resume, denied/cancelled tool calls, agent crash, blocking extensions, account switch, and unavailable team MCP. No implied IDE/plugin/UI parity. |
| **7c. Local Claude Agent SDK pilot (alternative)** | One API-key-authorized read-only specialist/session with explicit tool surface and approval bridge. Requires commercial/branding review; no claude.ai subscription login. | `claudeLocalSessions`, `cloud` + `self_hosted`, off; local-only. | Existing OpenCode sessions unchanged; SDK histories stay engine-owned and readable. Prove effective tools rather than `allowedTools` alone, permission-mode precedence, denied writes, user input, interrupts, credential isolation, and unexpected plugin/mod loading. |
| **8. Local SIWC feasibility, then consented pilot** | First confirm eligibility and the current engine's Responses wire compatibility. Only after approval: one local account, visible identity versus plan consent, one completed request, revoke/sign-out. Do not depend on 7a unless choosing Codex explicitly. | `chatGptLocalPlanAccess`, `cloud` + `self_hosted`, off, explicitly local-only. A later commercial hosted offering needs separate approval and `chatGptHostedPlanAccess`, `cloud` only, off. | Disable new plan requests, keep local history, respect revocation, retain existing provider choices without silently billing them. Prove issued-client/account/workspace binding, host ID persistence, PKCE/state/nonce, token rotation, denied consent, quota errors after partial output, unsupported tool/field rejection, and restart/resume if using App Server. |

Do not implement 7a–8 as a single "new engine" PR. Package distribution, provider
access, engine embedding, remote delegation, and billing consent must have
separate review and rollback boundaries. No new remote engine, runner
registration, SIWC/token-sharing service, route family, or hook is part of this
plan's current deliverable.

### Verification and rollout gates for future PRs

1. **Contract/source proof:** exact client/runtime versions, schema snapshot,
   package validation, static file/secret checks, and unit tests with negative
   cases. New dependencies get live vulnerability checks before addition.
2. **Host proof:** installation alone is insufficient. Record authentication,
   one real useful tool result, capability selection, unsupported request,
   revocation, and text/UI fallback in the host being claimed. Label every
   untested host separately; a successful local OpenWork test is not a vendor
   client certification.
3. **User-visible proof:** use the existing testkit workflow and
   [write-a-spec](../../.opencode/skills/write-a-spec/SKILL.md) for a missing
   journey. Evidence shows before/after, denial, offline, and kill-switch states.
   Native panel/UI PRs follow [DESIGN.md](../../DESIGN.md), especially P1, P3,
   P4, P9, P10, S4–S6, and C6. Attach host-versioned screenshot/recording evidence;
   never open a pane automatically merely because a tool returned an object.
4. **Integration regressions:** inspect and reuse existing
   [`mcp-auth-rate-limit-recovery`](../../evals/specs/mcp-auth-rate-limit-recovery.e2e.test.ts),
   [`mcp-consent-client-identity`](../../evals/specs/mcp-consent-client-identity.e2e.test.ts),
   [`mcp-app-servers`](../../evals/specs/mcp-app-servers.e2e.test.ts),
   [`mcp-app-transport-fallback`](../../evals/specs/mcp-app-transport-fallback.test.ts),
   and [`opencode-plugin-sign-in`](../../evals/specs/opencode-plugin-sign-in.e2e.test.ts)
   where relevant. They do not already prove a foreign native runtime. Run
   selected verification through [run-tests](../../.opencode/skills/run-tests/SKILL.md);
   classify any failing check before altering code.
5. **Deployment proof:** feature declaration precedes code; generated contracts
   accompany route/schema/registry changes. Run `pnpm features:check`. Pilot
   only our internal organization, separately per supported deployment. Kill
   blocks new work without losing existing history/receipts, and remains
   available independent of client package updates.
6. **Publication proof:** a working repo package is not a live public listing.
   Preserve review case IDs/status and require a human publication decision.
   Approval, enhanced placement, commercial partner enrollment, and payment
   entitlements must never be reported from inference or screenshots alone.

## 7. Open decisions and acceptance criteria

| Question / risk | Resolution before implementation or announcement |
| --- | --- |
| Does OpenAI accept OpenWork's public positioning and exposed operations? | Clarify native value/provider authorization and individually reviewed tool boundaries in the urgent listing track. A generic skill wrapper is not a solution. |
| Which exact vendor clients/versions are supported? | Fill a release-specific matrix with real authenticated workflows; maintain docs-only versus runtime-tested status. Do not turn a protocol client matrix into a blanket product guarantee. |
| Can an external host connect an authored App without the private catalog? | Prove discovery, agent-resource OAuth, `open_app`, revision resource, grants, and standard host rendering. Keep `mcp:app-host` private. |
| Which SIWC route applies to local open-source versus hosted paid OpenWork? | Obtain eligibility/security review; commercial offerings use the partner route. Establish consent and quota behavior, not just OAuth success. |
| Does OpenCode's current wire format fit SIWC preview restrictions? | Inspect actual provider requests and complete a supported local turn; catalog presence or a generic OpenAI-compatible driver is insufficient. |
| What is the Claude mod privilege budget? | Review the actual `validate` calls/events output; restrict implementation to explicit status/UI with no approval override, subprocess, secret access, or transcript export. Confirm managed policies and supported build. |
| How does a kill switch stop already installed native code? | Gate each enhanced action on verified state, use host disable/uninstall for local code, and enforce grants on the server. Do not promise remote deletion or reversal of local side effects. |
| Can foreign sessions keep current history/browser/automation behavior? | Define engine-owned histories and explicit adapter coverage first. Mark unsupported capabilities rather than silently falling back/replaying. |
| Can team/private instructions safely become public packages? | Export only owner-approved generic examples with no tenant names, credentials, internal IDs, receipts, or outside-person references. |
| Is a native convenience worth shipping? | Demonstrate a shorter path for one real task, bounded ongoing context cost, and an unchanged base gateway workflow when disabled. Otherwise keep the portable package. |

The success criterion for the next slice is deliberately small: a person installs
one client package, signs in with their own authorized account, reads one assigned
OpenWork playbook, and can disable the convenience without breaking their normal
client. Engine replacement, hosted execution, and subscription sharing are
separate product bets—not evidence required to finish that slice or the urgent
listing.
