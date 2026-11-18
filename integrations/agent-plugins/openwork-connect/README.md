# OpenWork Connect

OpenWork Connect packages the existing remote gateway at
`https://api.openworklabs.com/mcp/agent` and one shared skill for finding and
using the capabilities assigned to your OpenWork organization. It does not
include a server, hooks, commands, launchers, credentials, or new product
behavior. You need an OpenWork account and organization access; the MCP host
handles OAuth sign-in, and the gateway enforces the member's grants.

## Packaging and verification status

| Surface | Files | Status |
| --- | --- | --- |
| Portable Agent Plugins / Codex repo marketplace | Root `plugin.json`, `mcp.json`, `skills/`; repo `.agents/plugins/marketplace.json` | Offline invariants tested. Version 1.0.0 native install reported passed, but bundled-MCP runtime exposed no readers; source/policy/auth retest required. |
| Claude Code / Cowork | `.claude-plugin/plugin.json`, `.mcp.json`; repo `.claude-plugin/marketplace.json` | Offline invariants and 2.1.284 strict validation tested. Version 1.0.0 install reported passed; isolated OAuth blocked by account/binding prerequisites. |
| Native Cursor Plugin | `.cursor-plugin/plugin.json`, `.mcp.json`; repo `.cursor-plugin/marketplace.json` | Version 1.0.0 desktop install/OAuth/fixture/reconnect reported passed; named missing-item interpretation failed. Updated guidance needs native retest. |

Version **1.0.1** clarifies that keyword search is not proof of a specifically
named skill's identity: verify it with the exact reader and never substitute a
loose match after `unknown_skill`. Scoring, transport and OAuth are unchanged.
The reported native QA binds to the old version 1.0.0/pinned PR head, not a
passing retest of this update. Refresh, server-side revocation and isolation
remain untested. See [the QA packet](https://github.com/different-ai/openwork/pull/5851)
for the reported provenance, limitations and targeted retest.

These statuses describe this package, not the gateway's wider test history.
The dependency-free tests check metadata consistency, endpoint configuration,
assets, credentials, path boundaries, and standalone export. They are not full
upstream schema validators or a native-client smoke test. Additional read-only
checks use `claude plugin validate <plugin-directory> --strict` and
`claude plugin validate <marketplace-root> --strict`, including the standalone
export, with Claude Code 2.1.284. These preparation checks did not install a
marketplace; later computer-use QA reported the bounded installations above.

Use **Claude Code 2.1.281+** for strict directory-field and bundled-MCP validation.
The `icon` field is directory listing metadata, not a runtime feature. Older
validators warn on it and `--strict` fails, while loading strips the field and
installation can still succeed. The reported 2.1.156 warning is expected from
that documented version boundary; it is not proof of runtime failure. Do not
claim the old validator passed or remove listing branding merely to hide the
warning.

Root `plugin.json` and `mcp.json` remain the canonical Agent Plugins 1.0.0
package. Its transport is `streamable-http`. Claude's native `.mcp.json` uses
`http`; Cursor's native manifest explicitly selects that file with
`mcpServers: "./.mcp.json"`, rather than relying on native discovery of portable
`mcp.json`. All formats use the same skill and endpoint. Client manifest
precedence, authentication, and duplicate-connection behavior still need to be
checked in each supported native client.

The transport entry does not pin an MCP wire version, session identifier, or
protocol-specific header. Never add tokens, OAuth client secrets, or request
headers containing credentials to these files or to an install link.

## Local and repository marketplaces

**Custom connectors and local/repository marketplaces are not public store
listings, endorsements, or review approvals.** These catalogs make the package
discoverable in a source the user explicitly adds. They do not install it for
everyone, grant access, or bypass organization policy.

From a checkout containing these catalogs, or from the standalone export below,
use the following documented paths. The commands are instructions for a native
smoke test, not commands already exercised by this packaging change.

### Claude Code and Cowork

```sh
claude plugin validate /absolute/path/to/checkout/integrations/agent-plugins/openwork-connect
claude plugin marketplace add /absolute/path/to/checkout-or-export
claude plugin install openwork-connect@openwork
```

For an export, validate `/absolute/path/to/export` instead. Start a new Claude
Code session and inspect `/mcp` before testing the skill. In Cowork, add the
hosted Git repository as a marketplace under Customize > Plugins, then install
OpenWork Connect and connect its MCP server. Hosting/importing a repository is a
separate, explicit action; the exporter never creates or publishes one.

### Cursor

Import a Git repository containing `.cursor-plugin/marketplace.json` through
Customize or your team's marketplace settings. For local development, place or
symlink the complete plugin directory in
`~/.cursor/plugins/local/openwork-connect`, reload Cursor, and check Customize
for the skill and exactly one OpenWork MCP connection. Select the plugin
subdirectory in a monorepo; the standalone export is itself the plugin root.
Complete the host's OAuth flow before invoking tools.

### Codex

```sh
codex plugin marketplace add /absolute/path/to/checkout-or-export
codex plugin marketplace list
```

The `.agents/plugins/marketplace.json` catalog uses a `local` source relative to
the marketplace root, `AVAILABLE` installation, and `ON_INSTALL`
authentication. In a supported desktop host, choose the OpenWork marketplace,
install the package, and test it in a new conversation. Availability varies by
host; these files do not assert that every Codex surface can install plugins.

For the reported CLI **0.162.0-alpha.17.2**, `codex plugin add
openwork-connect@openwork` installs the package, but does **not** perform bundled
MCP OAuth. Test in one consistent isolated context with **no manual MCP server
registration named `openwork`**, not even a disabled one: a same-name configured
server outranks the plugin server and can prevent it from loading. Do not enable
the manual entry as a workaround or copy another profile's tokens.

Check `/plugins` for the bundled server and `/mcp verbose` plus `/warnings` for
startup/auth state. Complete normal `codex mcp login openwork` or `/mcp login
openwork` only after confirming the selected source is the plugin. Policy goes
under `[plugins."openwork-connect@openwork".mcp_servers.openwork]` and uses raw
`enabled_tools = ["list_skills", "get_skill"]` names. Native tool search may defer
those tools; absence from initial model declarations alone is not a runtime
inventory check.

That exact alpha supports this portable format but rejects newer per-server auth
extensions, so do not add one or a compatibility manifest blindly. Pinned
[source for the tested version](https://github.com/openai/codex/tree/740e5af33c71225640e0c1c1555c514c2c93ab74)
and the QA packet describe the distinguishing checks. The earlier failed run's
root cause remains unresolved until its safe effective policy/inventory is
inspected; this is a retest procedure, not a passing runtime claim.

**This general gateway is not eligible for the current public OpenAI plugin
directory:** its discovery plus generic executor exposes operations that are
not individually exposed for review, which violates the directory's tool
independence/exposure requirement. Codex repo-marketplace packaging is separate
from public-directory eligibility. No registered app ID, review attestation,
submission, or directory approval is included here.

## Export a small standalone repository directory

Run these offline commands from the OpenWork checkout; Node's built-ins are the
only dependencies, and no package install or network call is needed:

```sh
node scripts/marketplaces/export-plugin.mjs --check
node --test scripts/marketplaces/export-plugin.test.mjs
node scripts/marketplaces/export-plugin.mjs --output /absolute/existing/parent/openwork-connect-export
```

The output directory must not exist, its parent must exist, and it must be
outside every Git checkout. Paths are anchored to the script's checkout, not
the caller's working directory. Symlinked package files, extra files, unsafe
metadata, or embedded credentials fail validation before anything is exported.

The exporter copies only this package's allowlisted files and the three
marketplace catalogs, rewriting each catalog's source to `./`. The result has
`plugin.json`, both MCP formats, both native manifests, `skills/`, `assets/`,
`LICENSE`, `README.md`, and marketplace manifests at its root. Package files are
byte-for-byte copies; catalog rewrites are deterministic. It does not copy
`ee/`, monorepo history, `.git`, environment files, other packages, or scripts,
and never runs `git init`, pushes, creates accounts, accepts terms, or submits a
portal form.

Use this small directory, rather than the whole monorepo, when preparing a
separately hosted plugin repository: Anthropic's submission validator applies
repository archive limits even when selecting a plugin subfolder. Choosing a
host, making the repository public, uploading/submitting it, and native-client
verification remain separate manual steps. The source repository metadata
continues to identify OpenWork; no unpublished repository URL is invented.

## License and asset provenance

This package is MIT-licensed under the repository's grant for files outside
`ee/`. `assets/logo.svg` is copied unchanged from the MIT desktop asset
`apps/app/public/openwork-logo-square.svg`, not an Enterprise Edition asset.
The package license does not relicense the hosted service or any EE code.

## Official references

Packaging shapes and distribution guidance checked on 2026-10-09:

- [Agent Plugins specification and schemas](https://agent-plugins.org/plugin-authors)
- [Claude manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- [Claude repository marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude plugin support by surface](https://claude.com/docs/plugins/platform-support)
- [Claude submission and repository limits](https://claude.com/docs/plugins/pre-submission-checklist)
- [Claude connector versus plugin submissions](https://claude.com/docs/directory/publish)
- [Cursor native plugin and marketplace reference](https://cursor.com/docs/reference/plugins)
- [Cursor plugin distribution](https://cursor.com/docs/plugins)
- [Codex/ChatGPT packaging and repo catalogs](https://developers.openai.com/plugins/build/plugins)
- [OpenAI public-directory tool independence requirements](https://developers.openai.com/plugins/plugin-guidelines#tool-independence-and-exposure)

Public Claude and Cursor listings require their own review processes. This
package and its tests do not establish eligibility or approval for either
store, and no directory submission has been made.
