# Website links: open in a native app

Research and implementation review · 2026-09-17

| Option | UX and coverage | Failure and privacy model | Effort and decision |
| --- | --- | --- | --- |
| **A. Dynamic registered-handler item with explicit HTTPS mappings** | Add `Open in <registered app>` only when a narrow HTTPS mapping and a local protocol handler both exist. Preserve current browser entries and primary click. | Hide unsupported/missing-handler items; never guess missing IDs. Dispatch errors use the existing error dialog. App authentication remains app-owned. No network resolution. | **Small; recommended and implemented in the inspected working tree.** Vendor compatibility remains narrower than the menu/dispatch proof. |
| **B. A plus a per-domain “Always” preference** | Add an opt-in remembered destination and a visible way to reset it. Coverage still depends on A's mappings, not the entire domain. | Adds preference scope, unavailable-app behavior, migration, and undo requirements. Local preference storage can avoid resolution requests; SSO still cannot be guaranteed. | **Medium; defer.** No preference or primary-click change is implemented now. |
| **C. Native app as the default primary click** | Automatically launch the app for supported links; browser choices remain secondary. | Unexpected app switching, account mismatch, and failed handoffs affect ordinary clicks. Local mapping avoids resolution traffic but dispatch still exposes the URL to the destination app. | **Medium plus substantial regression surface; rejected on least-surprise grounds.** |
| **D. Generic OS “Open With…” picker** | Ask the OS to select an application for a URL. Platform support and eligible applications vary. | An HTTPS handler is usually a browser; a scheme handler is not proof that an app understands a particular website's page. Missing IDs and SSO remain unresolved. Local lookup need not use a network resolver. | **Large/platform-specific; not recommended for this change.** Domain routing and file-style application picking are not equivalent. |

## Recommendation and scope

Keep **A**: one contextual native-app choice, when eligible, alongside the existing browser choices. The ordinary click still opens the website through the existing thread-owned browser route. This is an additive escape hatch, not a new default routing policy.

Keep browser entries flat for the smallest diff. If installations with many browsers make the menu unwieldy, consider an `Open in Browser` submenu as a separate usability change. Do not introduce an arbitrary seven-item cap or silently drop installed browser choices.

This review documents the implementation and research boundary. Test outcomes are attributed to the structured receipts cited below. Publication and final-head evidence are tracked in [pull request #5112](https://github.com/different-ai/openwork/pull/5112).

## What the current code actually does

### Ownership and existing behavior

- `apps/desktop/electron/preload.mjs` captures eligible website-link context menus and sends `openwork:browser:linkContextMenu`. `apps/desktop/electron/browser-panel.mjs` owns the website-link menu and its actions; the native menu helper renders the popup. This is not a file-link-menu change.
- File links have their own Markdown/target actions. `apps/app/tests/markdown-file-link-actions.test.ts` distinguishes copy-path, reveal, local/remote file handling, and website links that retain native context-menu handling.
- `apps/desktop/electron/installed-browsers.mjs` uses a **fixed catalog plus filesystem checks**, not LaunchServices enumeration. It recognizes known installations of Safari, Chrome, Firefox, Edge, Brave, Arc, Chromium, Vivaldi, and Opera where supported. Relocated bundles, unlisted browsers, and some packaged Linux installations can be missed. Discovery has a bounded time budget.
- Generic external/custom-scheme dispatch already exists through `main.mjs` and `open-external.mjs`. That ability does not provide HTTPS-to-app mappings or identify which web domains an app understands.
- The supplied base review identifies [#5062](https://github.com/different-ai/openwork/pull/5062) and [#5064](https://github.com/different-ai/openwork/pull/5064) as merged. Its author-scoped open-PR search found no direct native-app-menu overlap. This is a point-in-time search result, not a claim that all related work is absent.

### Inspected change inventory

| File | Observed change |
| --- | --- |
| `apps/desktop/electron/native-app-links.mjs` | New pure, narrow HTTPS mappings for Notion, Linear, and Slack, plus injected protocol-handler-name lookup. |
| `apps/desktop/electron/browser-panel.mjs` | Resolve a mapped handler for website-link menus; insert `Open in <name>`; dispatch its URI; broaden generic error copy to mention apps. |
| `apps/desktop/electron/native-app-links.test.mjs` | Mapping, rejected URL, missing-handler, invalid-name, and lookup-error unit coverage. |
| `apps/desktop/electron/browser-panel.test.mjs` | Menu placement, exact dispatch, original-HTTPS policy checks, missing handlers, denied policy, and stale-source coverage. |
| `apps/desktop/package.json` | Include the new mapper tests in the desktop test command. |
| `evals/worlds/browser-panel.ts` | Configurable transcript-link fixture and a native-protocol witness world. |
| `evals/fixtures/native-app-protocol.cjs` | Test-only replacements for Electron protocol lookup and external launch, with recorded lookups/dispatches. |
| `evals/specs/browser-tabs-owned-by-thread.e2e.test.ts` | Focused native-menu journey, copy/cancel/stale-menu assertions, and absent/error/unmapped cases. |

The implementation resolves `app.getApplicationNameForProtocol(mappedUrl)` after mapping. Empty, throwing, control-character-bearing, or excessively long names hide the item. The label is the registered handler's display name, not a hard-coded vendor name. That name is presentation metadata, not authenticated vendor identity.

On selection, the code validates the selected item and checks policy against the **original HTTPS URL** with `external: true`, then rechecks menu/document currency before calling `shell.openExternal(nativeUrl)`. Copy retains the original HTTPS URL. Cancellation, invalid choices, and stale sources do not launch. A dispatch rejection produces `Could not open this link`; it does not silently launch a browser instead. A resolved dispatch promise does not establish successful sign-in or arrival at the intended object.

The native-item branch applies to `source === "link"`. This does not establish identical behavior for every embedded website's own page menu. The primary-click path was not changed by the inspected diff.

### Exact implemented mapping limits

| HTTPS input | Native output | Boundaries |
| --- | --- | --- |
| `notion.so` or `www.notion.so`, one or two path segments, final segment ending in a recognized page UUID | `notion://www.notion.so` plus path, query, and fragment | No custom domains, `notion.site`, or blanket `notion.com` rewrite. Query/fragment are retained. Third-party evidence supports the rewrite; it is not an official API guarantee. |
| `linear.app/issue/<ISSUE_ID>` | `linear://linear.app/issue/<ISSUE_ID>` | Only the short issue path, uppercase issue key and positive numeric suffix; no query/fragment. Workspace-prefixed issue paths and other Linear pages are excluded. |
| `app.slack.com/client/<TEAM_ID>/<CHANNEL_ID>` | `slack://channel?team=<TEAM_ID>&id=<CHANNEL_ID>` | Exact channel route, validated T-prefixed team and C-prefixed channel IDs, each with at least five following uppercase alphanumeric characters; no query/fragment. No messages, threads, DMs, or workspace-name archives conversion. |

The mapper rejects non-HTTPS URLs, credentials, explicit ports, lookalike hosts, raw backslashes, controls, malformed path escapes, encoded dot/slash/backslash path characters, dot segments, and duplicate path separators. These are checks on the string received by the mapper. The preload sends a browser-parsed `href`, so unit rejection of a raw spelling is not proof that every original HTML spelling reaches the mapper unchanged.

The mapper's comments and test name call these mappings “documented.” For public claims, distinguish **officially documented** Slack/Linear forms from the **third-party-supported** Notion form.

## Four UX options in detail

### A — conditional native choice: implemented recommendation

**Text sketch:** right-click an eligible link → `Open in OpenWork` → `Open in Default Browser` → `Open in <registered app>` → existing `Open in <browser>` entries → separator → `Copy Link Address`. When no eligible mapping/handler exists, omit only the native-app item.

**Coverage:** the explicit shapes above, and only when the relevant scheme has a registered handler. This is dynamically discovered availability over a deliberately static mapping catalog, not automatic discovery of arbitrary native destinations.

**Failures:** missing app or failed lookup hides the item. Missing IDs make a link ineligible. Uninstallation or a broken handler between lookup and dispatch can still cause an error. A valid handler can open an app that is signed out, in the wrong workspace, or unable to access the object; preserve the browser/copy alternatives rather than guessing another account or object.

**Privacy:** mapping and handler lookup are local; do not resolve redirects, query workspace APIs, probe localhost, fetch metadata, or send links to a routing service. On an explicit selection, the mapped URL is handed to the registered app, which may make its own network requests. This is “no resolution network,” not “no network activity.”

**Effort:** small production surface, with most added lines in tests and fixtures. Real vendor-app interoperability is a separate validation boundary.

### B — optional remembered destination: defer

**Text sketch:** retain A's choices; add an opt-in `Always open supported links from this domain in <app>` and an accessible `Reset link-opening preference` control.

**Coverage:** still A's supported shapes. A preference for a domain cannot manufacture missing IDs, convert arbitrary pages, or justify broadening URL validation. The wording must say “supported links” rather than promise every link on that domain.

**Failures:** define behavior when the app disappears, a mapping changes, or the user needs a different SSO session. Provide one-time browser override and undo before enabling automatic routing. Do not silently remember a selection just because the user used the native item once.

**Privacy and effort:** local preferences need no resolution service, but introduce persisted state, settings scope, reset/migration behavior, and cross-platform tests. Medium effort. No “Always” state or primary-click change belongs in the current patch.

### C — native primary click: reject

**Text sketch:** click supported HTTPS link → native app immediately; right-click → browser alternatives.

**Coverage:** no broader than A. Automatic routing does not solve ID availability or handler correctness.

**Failures:** missing apps require a defined fallback; stale registrations, SSO prompts, or wrong accounts now interrupt ordinary navigation. The user's expectation that a website link opens in the thread's browser is changed without a per-link decision.

**Privacy and effort:** the same local resolver can avoid lookup traffic, but primary clicks would routinely transfer URLs outside the embedded browser. Medium implementation effort with a much larger behavioral regression surface. Reject because the existing primary action is predictable and already has an explicit alternative.

### D — OS application picker: not a substitute for mapping

**Text sketch:** right-click → `Open With…` → platform picker → chosen application.

**Coverage:** OS-recognized handlers for the supplied URL or scheme, with different capabilities on macOS, Windows, and Linux. Passing an HTTPS URL commonly yields browsers, not every native app associated with its host. Passing a custom URI first still requires A's conversion knowledge.

**Failures:** unavailable applications may be excluded, but choosing an application does not supply missing workspace IDs or establish account access. SSO and object resolution remain app-owned; picker cancellation must be inert.

**Privacy and effort:** local enumeration can avoid remote resolution. Platform adapters, eligibility filtering, cancellation, packaging, and tests make this the largest option. File “Open With” and domain-aware web routing are a false equivalence.

## Platform findings: what can be discovered locally?

| Platform/API | Evidence and implication |
| --- | --- |
| Electron | [`app.getApplicationNameForProtocol`](https://www.electronjs.org/docs/latest/api/app#appgetapplicationnameforprotocolurl) looks up the protocol handler; HTTP and HTTPS are not per-domain native-app discovery. Display names are not stable application IDs. [`getApplicationInfoForProtocol`](https://www.electronjs.org/docs/latest/api/app#appgetapplicationinfoforprotocolurl) exposes richer information, including icons, on macOS/Windows; that is not universal app enumeration. [`shell.openExternal`](https://www.electronjs.org/docs/latest/api/shell#shellopenexternalurl-options) dispatches a URL to its external handler, without proving the destination page loaded. |
| macOS | [LaunchServices concepts](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/LaunchServicesConcepts/LSCConcepts/LSCConcepts.html) and [`LSCopyApplicationURLsForURL`](https://developer.apple.com/documentation/coreservices/1445148-lscopyapplicationurlsforurl) cover eligible applications. `LSCopyDefaultApplicationURLForURL` and NSWorkspace's `urlForApplicationToOpenURL` identify a default application for a URL. They do not provide arbitrary HTTPS-to-custom-URI translations. [Universal Links](https://developer.apple.com/documentation/Xcode/supporting-universal-links-in-your-app) use associated domains and an AASA relationship; they are distinct from custom protocol registration and can depend on interaction context. |
| Windows | [URI activation](https://learn.microsoft.com/en-us/windows/apps/develop/launch/handle-uri-activation) documents custom scheme handlers. App URI handlers for HTTP(S) association are a separate mechanism. Microsoft-specific schemes and registered custom schemes do not imply that arbitrary HTTPS pages can be opened in any installed application. |
| Linux | The [shared MIME-info specification](https://specifications.freedesktop.org/shared-mime-info/latest/ar01s02.html) defines `x-scheme-handler/<scheme>`. `xdg-mime query default x-scheme-handler/<scheme>` queries a desktop association; it does not infer native routing from website domains. Desktop environment and packaging differences remain relevant. |
| Android analogy | [App Links](https://developer.android.com/training/app-links/about) and [deep-link creation](https://developer.android.com/training/app-links/create-deeplinks) distinguish verified HTTPS associations from ordinary deep links. Verified `assetlinks.json` relationships can avoid a chooser. “Just once” / “Always” behavior is not a universal Material rule for desktop context menus. |

**Chrome limitation:** exact Chrome-on-macOS context-menu behavior was not independently proved. Do not claim Chrome automatically knows all native domains. Notion's [official desktop preference](https://www.notion.com/help/notion-for-desktop) is website/app-specific behavior. The unofficial [Open in Notion extension](https://github.com/creold/open-in-notion), also listed in the [Chrome Web Store](https://chromewebstore.google.com/detail/open-in-notion/kjemindnkfgkkfdekkinfamjahhlemca), explicitly redirects pages through a custom protocol; it is not proof of a generic browser-native domain registry.

### Menu guidance

Apple's [context-menu HIG](https://developer.apple.com/design/human-interface-guidelines/context-menus) favors a small, relevant set of commands and restrained grouping, roughly three groups rather than proliferating sections. It does not establish a hard seven-command cap. Microsoft's [menu guidance](https://learn.microsoft.com/en-us/windows/win32/uxguide/cmd-menus) discusses seven **groups**, not a universal limit of seven items. Keep the current small diff; assess a browser submenu against actual menu density as a follow-up.

## Vendor mapping evidence and exclusions

The table separates an app's protocol capability from a reliable rewrite of arbitrary web links. Angle-bracketed values are placeholders, not real account or content identifiers.

| App | Scheme/form and evidence | Mapping decision |
| --- | --- | --- |
| Notion | `notion://www.notion.so/<page>` is supported by [third-party implementation history](https://github.com/creold/open-in-notion). [Official desktop help](https://www.notion.com/help/notion-for-desktop) documents a desktop-opening preference, not a stable public rewrite API. | Implemented narrowly for recognizable page IDs. Treat compatibility as inferred/third-party-supported; do not advertise a vendor-guaranteed API or all Notion domains. |
| Slack | [Official deep-link documentation](https://docs.slack.dev/interactivity/deep-linking/) specifies `slack://channel?team=<TEAM_ID>&id=<CHANNEL_ID>` and `slack://open?team=<TEAM_ID>`. It requires IDs, not workspace subdomains or channel names. | `app.slack.com/client/<TEAM_ID>/<CHANNEL_ID>` has sufficient IDs for the implemented channel conversion. A workspace-name `/archives/…` link lacks the team ID: do not guess or fetch it. Opening a workspace alone is not an equivalent substitute for opening its channel/message. |
| Linear | [Official app documentation](https://linear.app/docs/get-the-app) explicitly describes `linear://` followed by the rest of the URL, including the short issue route, and a browser desktop-opening preference. | Implemented for the narrow short issue form only. The documented broader protocol does not mean every Linear path is covered by this patch. |
| Figma | `figma://file/…` is a candidate, inferred form; a stable generic rewrite is not proved here. [Official help](https://help.figma.com/hc/en-us/articles/360039824334-Open-links-in-the-desktop-app) describes desktop-opening UI and FigmaAgent/preferences. | Defer. Do not rewrite every Figma file, design, or community URL based on this evidence. |
| Zoom | `zoommtg://` and the browser-to-client launch flow are described by [Zoom support](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0070429). | Defer. Meeting links may involve launch parameters and browser authentication; no blanket HTTPS scheme replacement. |
| Google Meet | [Official installation instructions](https://support.google.com/meet/answer/10708569?hl=en) describe an installed PWA, not a traditional Meet custom URI scheme. | No traditional native-scheme mapping established. A PWA is not evidence for a `meet://` rewrite. |
| GitHub Desktop | `x-github-client://openRepo/…` is a candidate repository-oriented form, not a documented generic “open this GitHub page” contract in this review. | Defer; repository acquisition/opening and viewing an arbitrary issue, PR, or file are different actions. |
| VS Code | [Official command-line/URL documentation](https://code.visualstudio.com/docs/configure/command-line) describes `vscode://file/…`. | Requires a local path; it does not map arbitrary GitHub HTTPS pages to an existing local checkout. |
| Obsidian | [Official URI documentation](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI) describes `obsidian://open?vault=<VAULT>&file=<FILE>`. | Requires local vault/file knowledge; no generic web-domain conversion. |
| Granola | [Official introduction](https://docs.granola.ai/introduction) does not establish an exact supported desktop deep-link rewrite for this review. | Unknown; no invented protocol or mapping. |
| Jira | `jira://` is a historical candidate. [macOS link-opening support documentation](https://support.atlassian.com/jira-cloud-macos/docs/open-jira-links-in-the-macos-app/) concerns a discontinued Mac app. | Exclude as a current cross-platform mapping; historical documentation is not current compatibility proof. |

Slack and Linear's exact documented forms were re-fetched during this review. The other references preserve the supplied completed research, with uncertainties explicitly retained. Vendor documentation can change; protocol existence alone does not certify real-app end-to-end behavior.

## Product and competitor observations

| Product | Supported observation | What remains unproved |
| --- | --- | --- |
| Slack | Its [deep-link API](https://docs.slack.dev/interactivity/deep-linking/) lets another application target Slack. | It does not prove Slack offers a generic cross-app context menu for arbitrary website links. |
| Discord | A [public API discussion](https://github.com/discord/discord-api-docs/discussions/3347) discusses deep links. | Exact desktop menu labels and cross-app behavior are unknown; an API discussion is not UI evidence. |
| Teams / classic Outlook | [Microsoft support](https://support.microsoft.com/en-us/topic/open-file-links-directly-in-microsoft-365-desktop-apps-from-teams-and-classic-outlook-7c1a08d0-54d0-499e-992e-2c41f70b59a1) describes Office-file choices involving Desktop, Browser, and Teams in the supported Windows context. | This is not a universal native-app chooser for all website domains or every platform. |
| Notion / Linear | Their official desktop documentation describes app-specific opening preferences. | That does not establish a shared cross-product context-menu standard. |
| Arc | [Air Traffic Control](https://resources.arc.net/hc/en-us/articles/22932014625431-Air-Traffic-Control-Automate-Your-Link-Routing) routes links to Spaces/Little Arc. | Browser organization/routing is not native-app destination discovery. |
| Safari / Apple Mail | [Apple's Universal Links QA](https://developer.apple.com/library/archive/qa/qa1916/_index.html) supplies iOS interaction evidence. | It is not proof of exact macOS desktop context menus. |
| Gmail | No verified matching UI evidence in the supplied research. | Exact generic native-app-menu behavior is unknown. |
| Claude / Cowork | [Claude's documented desktop scheme](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link) establishes an inbound app-link capability. | Exact outgoing website-link context menus remain unknown without direct UI evidence/screenshots. |
| ChatGPT | [Built-in-browser help](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app) documents an outside-browser option. | It does not prove a generic native-app context menu or its exact labels. |
| Cursor / Codex | No verified matching menu screenshots were supplied. | Exact menus are unknown; do not invent parity claims. |

## Verification, evidence, and limits

Final-head receipts are published in pull request #5112's `test-evidence` sticky comment. The tables below distinguish selected tests, intentionally unselected tests, and baseline failures.

### Reported executor results

| Check | Reported outcome | Interpretation |
| --- | --- | --- |
| Focused unit tests | **95/95 passed** | Mapper/menu behavior within the tested unit boundaries. |
| Electron check | **Passed** | Electron validation succeeded. |
| Focused native-menu E2E, local and Daytona | **Passed: one selected test; seven intentionally unselected** | Only the selected journey is counted as passed. Unselected/skipped tests are not passed coverage. |
| Primary-click E2E | **Passed** | Existing primary-click route retained in the tested journey. |
| Revert control | **Failed when native item was removed; passed after restoration** | The selected journey detects absence of the feature rather than merely exercising a menu. |
| Evals typecheck | **Not green: 12 baseline progressbar errors** | The same errors occur on clean base. Do not report this command as passed or attribute those errors to this patch without contrary evidence. |

The focused receipt records three passed assertion artifacts/expectations and zero failed or pending expectations. Assertions cover synthetic mapped dispatch with browser state unchanged; original-HTTPS copy plus cancellation/stale-menu rejection; and absence of an item for missing handlers, lookup errors, or unmapped hosts. Final head evidence is published in the pull request's `test-evidence` sticky comment.

### What the witness proves

The fixture registers the synthetic display name **Workspace Chat in an in-memory test registry** and replaces Electron's handler lookup and `shell.openExternal`. The app renders a real native popup; the recorded native URL is the value dispatched across the mocked OS boundary. This proves OpenWork's selection, mapping, labeling, policy integration in the unit suite, and dispatch behavior under the witness's conditions.

It does **not** install a real vendor app, create a real OS protocol registration, verify a vendor's account/SSO flow, prove arrival at the target channel/page, or establish real-handler macOS/Windows E2E coverage. The popup captures prove visible UI in an isolated test Electron app, not vendor interoperability. Real vendor-app and macOS/Windows protocol integration remain unverified.

### Screenshots

![Website-link native menu before the change](https://b8tgacyg507ru26g.public.blob.vercel-storage.com/link-native-app/2026-09-17/native-app-menu-before-PXAlqV4OskTKrxY2ALPBle7SVQ70O4.png)

**Before — no handler:** the website-link context menu retains its existing browser and copy choices without a native-app item.

![Website-link native menu with the synthetic native handler](https://b8tgacyg507ru26g.public.blob.vercel-storage.com/link-native-app/2026-09-17/native-app-menu-after-rnsB1fhmSqOtkNDYMXA1yQy0p4UWyr.png)

**After — synthetic registered app:** the actual native popup includes the synthetic registry display name. This is not a screenshot of a vendor application launching.

## Decision record

Proceed with **A's implemented additive menu shape**, retaining the primary click and all current browser entries. Describe support as three narrowly mapped URL families with locally discoverable handlers, not “open any service in its native app.” Keep Notion's evidence level explicit.

Defer remembered defaults, a browser submenu, and broader vendor mappings to separately scoped work. A useful next compatibility exercise is real protocol-registration and vendor-app dispatch on macOS and Windows, including missing-app and signed-out states. No such real-vendor result is claimed here.
