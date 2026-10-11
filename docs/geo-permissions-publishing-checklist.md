# Permission-guide publishing checklist

Preparation date: **2026-10-10**. Status: **DRAFT — blocked for publishing**.

This branch is stacked on `feat/geo-guides-ready` at `28526860b`. It adds draft copy for `engineers-and-business-teams`, `ai-policies-and-controls`, and `prevent-shadow-ai`. The existing safe guides are unchanged. The guide array also feeds HTML, Markdown, JSON-LD, sitemap, and discovery, so merging this branch publishes the copy; draft status here is not a runtime publication gate. Keep the eventual PR in draft until this checklist is complete.

## Exact product blockers

At preparation, GitHub reported all of the following PRs **OPEN**, with no merge recorded. Recheck their status before publishing; open PR descriptions are proposals, not evidence of released behavior.

| PR | Preparation state | Proposed work |
| --- | --- | --- |
| [#5816](https://github.com/different-ai/openwork/pull/5816) | OPEN | Organization/team agent permissions, desktop enforcement, browser and local-extension coverage, behind `agentPermissions` (cloud and self-hosted, off) |
| [#5774](https://github.com/different-ai/openwork/pull/5774) | OPEN | OpenCode permission rules in permission sets |
| [#5775](https://github.com/different-ai/openwork/pull/5775) | OPEN | Den web permission-rule editor |
| [#5776](https://github.com/different-ai/openwork/pull/5776) | OPEN | OpenCode v2 command-rule enforcement |
| [#5777](https://github.com/different-ai/openwork/pull/5777) | OPEN | OpenCode v2 local-skill and MCP-server rules |
| [#5778](https://github.com/different-ai/openwork/pull/5778) | OPEN | Built-in browser website-rule enforcement |

- [ ] Confirm #5816, **or the complete #5774–#5778 stack with equivalent coverage**, is merged and deployed. Do not mix editor availability with proven enforcement. If using the alternate stack, verify its actual feature key and scope rather than assuming #5816's rollout contract.
- [ ] Confirm the released desktop and deployed Den versions include enforcement for every action claimed, across each engine generation claimed. A backend merge alone is insufficient.
- [ ] Confirm `agentPermissions` (or the verified alternate implementation's registry feature) is enabled for the working organization and deployment. Check kill switch, organization override, and feature-off behavior. Saved rules are not evidence of activation.
- [ ] Verify the supported plan/role requirements against the shipped API and docs before making plan claims. #5816 proposes Enterprise and `desktop_policies.view` / `desktop_policies.manage` authorization.

**No product PR is merged by this documentation task. No rollout is activated by this task.**

## Factual dry-run at preparation

Reviewed the original proposed guide blocks, current repository documentation, and the GitHub PR states above. This was a copy/source review, **not** a working-organization enforcement test. No screenshots were captured, no live rules were tested, and no feature was enabled.

Current evidence and resulting copy corrections:

- [`desktop-policies.mdx`](../packages/docs/cloud/share-with-your-team/desktop-policies.mdx) says most desktop controls are paused. The guides claim only custom-provider access and allowed desktop versions as current desktop policy/version controls. Extra workspaces, settings, extension installation, built-in extensions, alpha updates, command restrictions, and browsing restrictions are explicitly paused.
- Agent permissions are labelled **Planned** and carry the enforcement/release/feature-activation prerequisite. No current offline-enforcement or strictest-rule guarantee is inferred from proposed code.
- Organization model access through OpenWork and the plain `opencode-openwork` plugin is distinct from desktop permission enforcement. That plugin is not a desktop permission-enforcement plugin.
- MCP resource grants and connection tool switches apply only to calls through the gateway, not the client's shell, independent tools, or the entire device. Claude Code, Codex, and Cursor are not described as having available AI Gateway inference integration.
- Organization SSO/SCIM revocation is not presented as revocation of independent provider sessions or external accounts.
- Admin audit events and usage reporting are not an exhaustive record of client tools or external connector side effects. Removed blanket audit, privacy, and shadow-AI-prevention guarantees.
- Current source and documentation links are available in guide cards; proposed enforcement is not linked as released documentation.

## Working-organization evidence before publishing

- [ ] Record verification **date**, deployed Den revision/version, released desktop version, OS, engine version, plan, and anonymized organization label. Do not include outside identities or organization names in public evidence.
- [ ] Capture a screenshot of the working organization's permission rules and effective **feature enabled** state. Include readable scope (organization/team) and relevant rules, not merely the presence of an editor.
- [ ] Demonstrate an allowed command, a blocked command with its rule named, and an Ask-first command. Verify file-edit, website/browser, skill, and local-MCP behavior before claiming each capability.
- [ ] Verify team resolution with actual effective rules, rather than assuming paused desktop-policy combination semantics apply.
- [ ] Verify feature-disabled behavior and document that turning the feature off can remove enforcement. Verify refresh/restart timing and offline behavior before making any related claim.
- [ ] Check an MCP-client local command remains outside gateway tool-switch controls; verify independently configured connections are not described as controlled.
- [ ] Check organization revocation separately from independent provider sessions; retain this boundary in the published wording.
- [ ] Check which admin events and usage fields exist; retain the limitation on external connector side effects and avoid completeness/privacy guarantees.

## Copy, docs, and final review

- [ ] Update product docs to match the released behavior, including paused controls that remain paused. Reconcile the desktop-policy warning before changing any guide from Planned to current.
- [ ] Update guide answers, FAQs, tables, review dates, metadata, and `llms.txt` consistently. Keep future capabilities labelled Planned until independently verified; do not replace one blanket guarantee with another.
- [ ] Review HTML, Markdown, FAQ/Article JSON-LD, index, and sitemap for consistent status wording. Attach real-size page screenshots to the eventual PR (DESIGN.md P1 and P10); parent session owns screenshots and PR creation.
- [ ] Run `git diff --check` and landing TypeScript verification again on the final stacked branch.
- [ ] Obtain publishing approval after the blockers and evidence are complete. This task commits and pushes draft documentation only; it does not open a PR or merge product work.
