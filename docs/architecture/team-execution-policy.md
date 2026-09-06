# Team execution policy

Den's existing Team → Access editor owns team restrictions. The desktop shows
those same restrictions in Account → App permissions. Engine versions are an
implementation detail; administrators edit one document.

The document adds an optional `execution` object to the existing desktop policy.
Missing execution settings preserve existing behavior. Matching policies combine
command denials and blocked patterns; approved site lists intersect. An empty
approved list denies every site. Existing boolean grant and team-access semantics
remain unchanged.

| Den setting | Runtime mapping | Additional enforcement |
| --- | --- | --- |
| Run OS commands | OpenCode `permission.bash` / `permissions` action `shell` | Before-tool hooks, before-shell hook, and direct engine request guard |
| Blocked command patterns | Same shell rule targets | Shared command matcher; patterns are not a shell sandbox |
| Approved websites | Native fetch/search denied; use built-in browser | Browser session request interception, including frames, redirects and script requests |
| Block browser uploads | Browser request method and upload-body checks | POST, PUT, PATCH and other non-read methods are denied |
| Add AI providers | Den catalog plus the separately permitted built-in provider | Local custom provider writes and unassigned organization model dispatch are denied |
| Use OpenCode models | Existing provider policy | Model dispatch rejects the built-in provider when blocked |
| Manage extensions | Existing Library restrictions | Local extension, skill and MCP mutation routes |
| Change app settings | Existing settings visibility | Server configuration mutation routes |
| Create more workspaces | Existing workspace visibility | Local and remote workspace creation routes |
| Alpha updates / welcome page | Existing desktop controls | UI behavior, not engine permissions |
| Token accounting | Existing inference usage records and engine message usage | No new budget or spending policy |

`managed-policy-rules.ts` lists a target for every existing desktop control and
every execution setting. The exhaustive TypeScript objects fail compilation when
a new key has no mapping. Both engine adapters read this representation.

`writeManagedDesktopPolicy` accepts a validated response from the signed-in Den
session. Ordinary runtime writes preserve that managed value, and all writes are
serialized. A source-boundary test rejects additional callers of the managed
writer. Local configuration cannot replace the managed document. Runtime hooks
verify policy before execution, while the normal engine refresh mechanism updates
native configuration. Policy reads in flight are shared to prevent older parallel
responses from replacing newer policy.

The browser restriction applies to OpenWork's built-in browser. Native fetch
and search are blocked while approved sites are configured: their redirects do
not expose a per-request enforcement hook. The agent is directed to the built-in
browser for approved-site reading. It is not device-wide DLP: allowed sites can receive data in read URLs,
existing third-party extensions have their own transports, and arbitrary allowed
OS commands can use other network clients. Disabling OS commands closes the shell
route; a device-wide outbound guarantee still requires a sandbox or network
control outside this feature. Installed extensions are not automatically removed.
Saved commands and interactive terminals are blocked when command restrictions
apply. Saved command templates can evaluate shell substitutions before normal
tool hooks, so their entry point must also be guarded.

## Verification

Extend `evals/specs/desktop-policy-restricted-mode.e2e.test.ts`: one Den admin,
one team member, and a second member outside that team, each in an isolated real
desktop. The admin saves in Den. The test checks persisted and effective policy,
UI restrictions, direct API bypass attempts, browser requests and uploads, and
real engine command execution with independent file witnesses. Run the journey
with `OPENWORK_EVAL_ENGINE=v1` and `OPENWORK_EVAL_ENGINE=v2`, using the full feature
commit as `OPENWORK_EVAL_REF` and `OPENWORK_EVAL_DAYTONA_REF` for remote placement.

A passing evaluator response alone is not proof that an action was blocked.

Upstream contracts: [legacy shell identity](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/tool/shell/id.ts),
[legacy command substitution](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/prompt.ts#L1317),
[current permissions](https://opencode.ai/v2/docs/permissions), and
[execution hooks](https://opencode.ai/v2/docs/build/plugins).
