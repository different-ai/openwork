# Workbot: inline browser preview

Feature: `workbotBrowserPreview` · Cloud and self-hosted · Default **off** · Author: @benjaminshafii.

During live browser/computer work, the reply includes a compact card: current status, a passive live thumbnail and one **Open browser** (or **Open computer**) button. This remains a preview, not a takeover: no automatic full-screen view, tab navigation or control. Background commands have no screen and never get a preview. Finished replies no longer leave the bare Open Computer row: once the work is over, the card becomes a compact record that stays in the conversation (also after a reload), "Browser · Opened google.com" with the last picture while this page still has it, and opens the full view only on tap. A card is the Browser card from its first frame: the runner reports which view a desktop call works in as soon as the model writes it, and the page shows no card for screen work until it knows which screen. When this flag is off the previous card/navigation behavior remains.

The viewer is the existing view-only stream. No browser-runtime fixes are included. If no frame has ever arrived, the card shows its status and button without a grey/fake thumbnail. A last real frame appears immediately on reconnection when one exists. The last frame is labelled as such, retained only in page memory, keyed by organization/member/chat/view, capped at four small images, and expired after five minutes. It is never written to localStorage or sent to a server. Failed access clears it. Permission checks for viewer tickets remain unchanged. Revocation and unavailable streams cannot show a made-up live picture.

## Mobile verification

Real WorkbotScreen, 390 × 844, in-memory conversation with recorded Chromium pixels replayed through the fixture WebSocket (not a real task's browser). External PR evidence, retained for 72 hours:

![Inline thumbnail and one Open browser action](https://litter.catbox.moe/b8zatl.png)

## Try it

Enable `workbotBrowserPreview` for a test organization in `/admin` → organization → Features, with browser/computer access already enabled. Reload Workbot, ask it to open YouTube, verify the first reply/card, then tap Open browser. Nothing should open before the tap. Stop the turn: the live card is replaced by its finished record.

Local UI fixture: `?scenario=browsing&browser=1&working=1&profile=1&preview=1`. Screenshots, console/network results and verification limitations are linked in the PR. The fixture uses the real screen and an explicitly simulated stream; this does not verify external sites or production runtime behavior.

Turning the flag off restores the prior presentation, closes the new inline viewer on rerender and leaves ongoing work untouched.
