# Computer session history

Feature: `computerSessionHistory`. Cloud and self-hosted. Author: `reachjalil`.
Off by default.

Computer actions in one assistant turn share a compact card. Open it to browse
the screenshots the agent received, play them in sequence, or inspect the
original actions. Narration, other attachments, failed calls and approval
requests remain in the conversation. No new recording or screenshot capture
is introduced.

Built-in browser steps are not part of the card; they keep their usual
"Used browser" steps in the conversation.

While the feature is on, the floating live computer view no longer opens by
itself: the card shows the work. While the chat's computer is working, the
newest card offers **Watch live**, which opens the usual floating view (it can
still pop out into its own window), and **Hide live view** closes it again. The
view still opens on its own when the person is needed, such as after a
takeover. The next computer session starts in the card again.

![Computer session history open in the chat](computer-session-history.webp)

Enable the feature for a test organization or member in platform admin, then
open a conversation with computer actions. Signed-out clients follow the
deployment's feature setting. A missing or unreachable setting stays off.

The collapsed card follows the newest capture. Browsing an earlier view pins
it while new captures arrive; scrubbing to the end returns to following. Playback is
explicit, stops at the final view, and pauses when closed or the tab is hidden.
Unchanged consecutive captures share one view; every action remains available.
Sessions without screenshots still offer their actions. Interrupted work is
shown as status unavailable rather than reported complete.

Turning the feature off immediately restores individual actions and image
attachments. Stored conversation data is retained and no computer input is sent
by browsing or replaying history. Existing Computer view controls and approvals
keep their current behavior.
