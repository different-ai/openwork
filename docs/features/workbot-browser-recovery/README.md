# Workbot browser recovery

- Feature: `workbotBrowserRecovery`
- Deployment: cloud; default **off**
- Owner: `benjaminshafii`

## What changes

When on for a member/organization, Workbot retries **reads only**, once, if a
page navigates while it is being observed or extracted. It waits for the page
to settle before retrying. It reconnects a closed CDP connection to a tab that
still exists on its next operation. It reports generic consent dialogs and
human-verification checks, with guidance for the agent. It never clicks a
consent option automatically or solves a human-verification check.

Clicks, typing, navigation, website tools and submissions are never replayed.
Takeover, cancellation, tab ownership, policy checks and withheld field values
keep their existing protections. A second failed read reports the failure.

The flag is resolved by Den for the signed-in member, sent server-to-server to
Workbot, stored as a trusted runner session setting and passed separately from
the model's tool arguments to the desktop guest. Older Dens/hosts omit it (off).
Older runners gracefully ignore this setting without losing other settings.
Workbot refreshes settings when preparing a conversation for a turn. Turning
it off takes effect on subsequent tools after that refresh; an in-flight read
can finish, but no clicks/submissions are retried by either setting.

## Fixes independent of this rollout

These restore intended browser behavior and ship without the flag:

- A self-reload or redirect replaces the original loader ID during navigation;
  wait for the current document, not a loader that no longer exists.
- Only the top document and the actual observation world invalidate refs.
  Embedded ads/iframes changing do not invalidate the entire page.
- Bounded settling after open/navigation (8 seconds), and a bounded retry of an
  empty text **read** after loading; timeout reports `still_loading` rather than
  falsely claiming navigation failed. Network streams do not hold the wait open.
- Navigation gets 30 seconds for its initial response and up to 10 seconds for
  a readable document. A timeout never causes automatic navigation replay.
- Specific navigation error codes, safe diagnostic categories in guest logs,
  and recovery instructions replace the generic “Check browser” status.
- A transient page change is not a stuck `needs_attention` state. A subsequent
  successful operation already clears attention. No automatic takeover/resume.

## Try it

Enable `workbotBrowserRecovery` for a test organization using the existing admin
Features page. Use a fresh Workbot chat, then ask to open YouTube and search for
a topic. On a first visit YouTube may reload with `?themeRefresh=1`. Opening
should still succeed, and observing the page should not fail when embeds load.
Try a site with a cookie dialog and confirm the agent sees the dialog rather
than claiming the underlying content is empty. Complete any human-verification
check yourself in the browser; the agent must not attempt to solve it.

From a phone: ask “Use the browser to open YouTube, search for relaxing music,
and tell me the first three results.” Open the browser row/preview; it should
show the page, permit Take over and Continue, and return readable results. A
separate UI change owns inline previews, chat acknowledgements and first-frame
retention; this feature changes neither viewer endpoints nor streaming.

## Observe and revert

Unexpected browser failures emit `[cloud-browser]` with operation, code,
dispatch status and a fixed diagnostic category (never URL, text or values).
Use existing `[headless-computer] desktop timing` logs for VM start/lookup,
desktop start, health and viewer endpoint timing. Watch operation failures,
`still_loading` outcomes and desktop start durations before widening rollout.

Turn the flag off or kill it in the existing feature registry to disable new
read recovery and blocker guidance without changing saved tabs, cookies,
files, permissions or viewers. Pure bug fixes remain; revert the PR to undo
those too. No snapshot image or provider capacity is provisioned by this flag.
