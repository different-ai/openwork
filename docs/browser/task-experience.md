# Browser tasks

A browser task keeps its conversation, selected tab and signed-in context across
website tools, DOM controls and images. The built-in browser uses Electron's
persistent browser partition. Tab ownership isolates control and visibility;
it does not create a different website account for every conversation.

## User experience

The first browser operation in a session asks **Allow this agent to use the
browser?** once. **Allow for this session** lasts until desktop restart: takeover,
cancellation and closing tabs never ask again. There are no per-action or
per-tool prompts and no operation time limit. Organization policy and takeover
are the other gates. Denying returns `user_denied`; a prompt dismissed without a
choice (cancellation, closed tab) returns `canceled`, never `user_denied`.

1. List the conversation's tabs and reuse a matching page, or open the requested
   URL in a new owned tab, using the built-in browser's signed-in account. A new
   session's first tab stays blank until the session is allowed.
2. Discover site tools. Prefer a relevant structured integration or site tool;
   otherwise observe the page and use its visible controls. A fresh image
   supports a coordinate click without a useful DOM reference.
3. WebMCP tools run and return their bounded result to the conversation. A
   site's read-only annotation is advisory and never makes a retry safe.
4. Choose **Take over** to pause the conversation's browser operations. Sign in
   directly in the page, then choose **Resume browser**; actions need a new
   observation. Opening another tab cannot bypass takeover.
5. Observe the requested result. An input event being dispatched and a site
   callback returning are separate from the user's desired outcome being met.

Background tabs keep their conversation ownership and cannot switch the visible
conversation, and browser operations work in them without selecting the tab.
Ordinary popup windows stay in
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
observations carry random IDs and must be no older than 15 seconds when an action
starts. Before dispatch the host rechecks observation identity, document, URL, policy,
DOM changes, viewport, scroll and target readiness. Key input also requires the
same directly focused native input, textarea, select, button or link. Keyboard
input to frames, shadow hosts and generic/custom editors is refused because their
actual focused descendant cannot be verified; the person must take over. This
includes closed shadow roots, which cannot be detected from a host's `shadowRoot`.
Coordinate clicks require an image scaled to the page
viewport and recheck its pixels before dispatch. The reviewed action payload is
copied once and never replaced silently. Actions consume their
observation before dispatch; failure or cancellation clears it. Timeouts and
uncertain outcomes prohibit automatic replay, including through another method.

Each conversation has one in-memory control scope. Takeover, disabling control
and closing the last owned tab abort its in-flight operations without clearing
the session allow. Cancellation aborts only that operation. Takeover stops pending
task loads; only explicit address-bar, Back, Forward or Reload actions enable
manual navigation. Webpage mouse and keyboard input do not enable navigation.
Browser access is not task authorization for unrelated or consequential work,
and nothing expands the organization's managed policy.
The existing async `checkPolicy`
boundary checks task access, DOM actions, site-tool discovery and invocation.
There is no renderer-managed website grant or parallel policy cache. `execution.browserOrigins` matches exact scheme, host and port
and intersects across policies; it does not union host patterns or wildcards.

The browser session's request-policy hook in `browser-panel.mjs` remains the
only `onBeforeRequest` listener. It checks all network requests, including redirects,
frames, subresources, scripted requests and uploads. `blockBrowserUploads`
remains authoritative, and a denied request
never falls back to an external browser.

The same request listener holds task-controlled main-frame requests, including
cross-origin redirects, until managed policy permits dispatch. It checks
cancellation, tab identity and ownership before releasing the request. A paused
task cannot treat a late redirect as manual browsing.

This is not a complete browser egress sandbox. Frames, images, scripts, fetches
and other subresources remain governed by the existing managed request policy.
If that policy permits them, a thread can navigate between origins. Exact managed URL origins are not a DNS/IP
classification or DNS-rebinding defense, and the browser still shares its
persistent signed-in profile across conversations.

Scroll actions use viewport-relative CSS pixels with positive `deltaY` scrolling
down and negative scrolling up, limited to 1,200 pixels per action. Clicks and
wheel input use Chromium's input router so hit-testing also reaches embedded
frames. Observations include the top document's `scroll: { x, y }`; this is not
the position of a nested scrolling element. A dispatch receipt still requires
fresh outcome verification.

Tasks use the built-in browser's existing sign-in. Sign in directly in the page
and resume the task; the persistent partition keeps that session available.
Browser task tools never read another browser's profile.

Popups force the same sandbox, context isolation and same-origin security as
ordinary tabs, regardless of website-supplied features. The per-frame preload
installs only an isolated, sandboxed bridge; it exposes no Node APIs to website
JavaScript. Browser tools do not acquire OS pointer control.

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
frame, schema and registration before running and before returning. Handles carry
the requesting conversation and navigation revision. Discovery spanning a
navigation is rejected instead of publishing stale handles.

Input schemas use a bounded JSON Schema 2020-12 subset. `pattern`,
`patternProperties` and all `format` validators (including `regex`) are
unsupported, including in nested schemas and definitions. Discovery reports
each rejected descriptor in `rejectedTools` without hiding valid tools. Those
schemas are rejected before compilation, not silently
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
execution policy and workflow dashboard panels remain
owned by their current implementations. Browser tasks reuse those boundaries.
The browser access
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
deterministic provider and controlled website witnesses for the single session allow, signed-in
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
quality for every provider. Direct control of external browser profiles,
declarative WebMCP, closed-shadow-root DOM references, file transfer and restart
restoration of live tab handles remain outside the browser-task subset.
