# Browser tasks

A browser task keeps its conversation, selected tab and signed-in context across
website tools, DOM controls and images. The built-in browser uses Electron's
persistent browser partition. Tab ownership isolates control and visibility;
it does not create a different website account for every conversation.

## User experience

1. List the conversation's tabs and reuse a matching page, or open the requested
   URL in a new owned tab. An ambiguous reference needs actual tab context.
2. Review website access in the browser panel. This allows reading that origin
   for this conversation during the current desktop process.
3. Discover site tools. Prefer a relevant structured integration or site tool;
   otherwise observe the page and use its visible controls. A fresh image can
   support a coordinate action when a control has no useful DOM reference.
4. Review each website action separately. A site's read-only annotation is
   advisory. Approvals bind the operation to its tab and current page.
   After a site callback returns, review its complete bounded result locally
   before choosing **Share result**. This separately authorizes disclosure to
   the conversation and its model provider. Denying keeps the payload private;
   it does not undo the action or permit an automatic retry.
5. Choose **Take over** to pause the conversation's browser operations. Sign in
   directly in the page, then choose **Resume browser**. The next action needs a
   new observation. Opening another tab cannot bypass takeover.
6. Observe the requested result. An input event being dispatched and a site
   callback returning are separate from the user's desired outcome being met.

Background tabs keep their conversation ownership and cannot switch the visible
conversation. A background operation needing approval returns `needs_attention`;
the user opens that conversation and retries. Ordinary popup windows stay in
owned built-in tabs, using the same profile and opener. Non-HTTP(S) popups are
refused. A closed tab is an explicit error, never silently replaced.

## Execution contract

The existing Browser extension's installed identity now resolves to the desktop
browser host. Its tools are `browser_tabs`, `browser_open`, `browser_observe`,
`browser_act`, `browser_navigate`, and `browser_handoff`. The site tools remain
`webmcp_list_tools` and `webmcp_call_tool`. The trusted execution context supplies
the conversation ID; it is not a model argument. The authenticated loopback
bridge is an internal desktop capability, not an external browser connection.

The supported tools do not expose arbitrary evaluation, raw CDP, cookies,
storage, network response bodies, uploads or the system clipboard. This is a
browser-tool boundary; it does not sandbox unrelated shell tools or user-added
plugins with independent machine permissions.

Each tab allows one operation at a time. There is no mutation queue. DOM
observations carry random IDs and expire after 15 seconds, DOM changes or
navigation, scrolling or viewport changes. Coordinate clicks require an image
scaled to the page viewport and recheck its pixels before dispatch. Actions consume their observation before dispatch. A failure or
cancellation clears it. Timeouts and uncertain outcomes prohibit automatic
replay, including switching to another method to repeat the action.

Browser access, action approval and result disclosure are separate. None can
expand the organization's managed policy. The existing async `checkPolicy`
boundary checks task access, DOM actions, site-tool discovery and invocation,
and result sharing. There is no renderer-managed website grant or parallel
policy cache. `execution.browserOrigins` matches exact scheme, host and port
and intersects across policies; it does not union host patterns or wildcards.

Electron's existing `installPolicyRequestHook` remains the only
`onBeforeRequest` listener. It checks all network requests, including redirects,
frames, subresources, scripted requests and uploads. `blockBrowserUploads`
remains authoritative. User consent cannot bypass it, and a denied request
never falls back to an external browser.

Tasks use the built-in browser's existing sign-in. Sign in directly in the page
and resume the task; the persistent partition keeps that session available.
External profile import and login syncing are separately owned work, not part
of this feature. No cookies are imported or copied from another browser.

Popups force the same sandbox, context isolation and same-origin security as
ordinary tabs, regardless of website-supplied features. The per-frame preload
installs only an isolated, sandboxed bridge; it exposes no Node APIs to website
JavaScript. Native computer use owns OS app and window sessions separately;
browser tools do not acquire OS pointer control.

Activity retains operation names and state, not arguments, result bodies or
cookies. Observations intentionally return requested page content to the
conversation. Password and one-time-code fields require user handoff; image
capture refuses pages with those fields. Use controlled fixtures for evidence.
Site callbacks may return secrets under arbitrary field names, so key-name
redaction is insufficient. Their results remain local until the separate
disclosure review succeeds. Missing review support, denial, cancellation or
policy loss withholds the payload and preserves the uncertain-action receipt.

## WebMCP compatibility

The host implements the imperative `document.modelContext` path with an
isolated preload bridge. When the runtime does not supply that API, the existing
compatibility implementation supplies it. Discovery validates names, bounded
JSON Schemas, frame policy and origin. Every invocation rechecks the document,
frame, schema and registration, both before and after approval. Handles carry
the requesting conversation and navigation revision. Discovery spanning a
navigation is rejected instead of publishing stale handles.

Input schemas use a bounded JSON Schema 2020-12 subset. `pattern`,
`patternProperties` and all `format` validators (including `regex`) are
unsupported, including in nested schemas and definitions. Discovery reports
each rejected descriptor in `rejectedTools` without hiding valid tools. Those
schemas are rejected before compilation or action approval, not silently
accepted with their constraints ignored. Literal data and property names may
still contain those words. References are limited to named local `$defs` or
`definitions` entries; arbitrary JSON pointers, remote and dynamic references
are unsupported.

The supported subset includes same-origin frames and explicitly delegated secure
cross-origin frames. Declarative HTML form tools, the older
`navigator.modelContext` API and external-browser WebMCP are unsupported.
Returned capability metadata names those limits. A website result remains
untrusted even if its tool claims to be read-only.

## Integration boundaries

Conversation-owned tabs, background-view parking, viewport recovery, team
execution policy, native computer use and workflow dashboard panels remain
owned by their current implementations. Browser tasks reuse those boundaries.
External profile syncing remains separate in #4452. The browser access
mechanism from #4481 is superseded by the merged execution policy in #4564;
this feature adds no Den policy fields or login-import API.

## Design sources

The native boundary follows Electron's
[sandbox contract](https://www.electronjs.org/docs/latest/tutorial/sandbox).

These are public contracts and examples reviewed on September 4, 2026. They
motivate the choices above; they do not document another product's private
planner, prompts, permission classifier or runtime implementation.

- [WebMCP draft](https://webmachinelearning.github.io/webmcp/): document-scoped
  tools, registrations, cancellation, origin restrictions and untrusted metadata.
  The draft is not a finalized W3C standard, so the supported subset is explicit.
- [Chrome WebMCP preview](https://developer.chrome.com/blog/webmcp-epp): imperative
  and declarative approaches are distinct capabilities. A runtime must not
  advertise declarative support merely because imperative registration works.
- [Public site-tools behavior](https://learn.chatgpt.com/docs/webmcp): tools share
  the live page and authentication, disappear as the page changes, and still
  require review. Callback completion does not establish asynchronous outcomes.
- [Public browser behavior](https://learn.chatgpt.com/docs/browser): separate
  built-in profile, site access distinct from sensitive action approval, and
  direct sign-in handoff. These are user-visible patterns, not an implementation
  blueprint.
- [Public browser-extension behavior](https://learn.chatgpt.com/docs/chrome-extension):
  existing external tabs are a different connection, and dedicated integrations
  can be preferable when available. No external connection is inferred here.
- [Playwright locators](https://playwright.dev/docs/locators) and
  [actionability](https://playwright.dev/docs/actionability): prefer meaningful
  controls and recheck visibility, enabled state and hit testing before input.
  This host uses Electron DOM references rather than introducing another
  browser process or Playwright-owned authentication context.
- [Playwright isolation](https://playwright.dev/docs/browser-contexts): browser
  contexts isolate cookies and storage. Sharing one persistent profile here is
  therefore explicitly different from account isolation.
- [Electron navigation and popup APIs](https://www.electronjs.org/docs/latest/api/web-contents)
  and [security guidance](https://www.electronjs.org/docs/latest/tutorial/security):
  enforce navigation in the main process, keep renderer isolation, and control
  popup creation. The existing all-request policy hook covers programmatic loads.

## Verification and limits

`webmcp-browser-agent` is the browser-task journey: real engine plugins with a
deterministic provider and controlled website witnesses for consent, signed-in
invocation, DOM/image fallback, popup isolation, exact iframe delegation,
cancellation, stale observations and observed completion.
`browser-tabs-owned-by-thread` and `browser-panel-viewport-recovery` own
background visibility and viewport restoration. Managed-policy coverage must
exercise exact origins, their intersection and upload restrictions through the
existing native/server boundary. Source checks alone are not runtime proof;
these journeys require fresh evidence after reconstruction.

The implementation is model-independent. Text-only models can use page text and
site tools; visual work requires an image-capable model or user assistance.
The desktop and its local server must run on the same machine. A remote server
without its own desktop browser returns an unavailable result; this does not
connect to a different machine's external browser.
The deterministic provider verifies tool availability, execution context and
result delivery and a verified completion answer in the conversation. It does not prove open-ended planning
quality for every provider. External browser profiles, declarative WebMCP,
closed-shadow-root DOM references, file transfer, restart restoration of live
tab handles, and continuous login sync remain outside the supported subset.
