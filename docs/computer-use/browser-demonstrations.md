# Teach Workbot browser tasks

A member can demonstrate a task in their conversation's browser, explain its
steps in chat, and save the result as a private Cloud skill. This builds on the
shared desktop and input controls; it uses the ordinary skill library and
`create_skill` / `get_skill` tools.

Enable `browserDemonstrations`, `browserUse`, and `remoteComputers` for the
organization in `/admin`; `computerUse` is not needed. The teaching rollout is
off by default on cloud and self-hosted installations. The conversation needs a
desktop built with the current guest bridge. An older one reports that teaching
is unavailable until it moves to a current build (see
[Prepare the headless runner](workbot.md#prepare-the-headless-runner)).

## Teach, review, and run

1. Open Browser → Teach Workbot. Choose the browser tab, then Start teaching.
   With the browser live view, the tab on screen is chosen unless you pick
   another, and tabs are named as in the tab strip. The taught tab comes to the
   front. The person owns browser input while teaching.
2. Navigate, enter search inputs, and use the page normally. Explain intentions
   in the conversation before or after an action. Workbot receives recent
   semantic steps with the explanation, using read-only turn credentials. The
   normal chat composer shows whether recording is active, paused, or under
   review, and which step the explanation applies to.
3. Choose Select information, then click a field in the browser. That click
   selects an extraction target instead of activating the page control.
4. Open Recorded steps and select an earlier action to explain or correct it
   in chat. Use latest step returns chat to the current action. Input and output
   names accept ordinary words such as “Person name.” Each recorded field edit
   starts as a parameter; the entered value is omitted. Pause recording for
   activity that should not enter the skill; explanations still work while paused.
5. Finish teaching, name the skill, describe when to use it, and review its
   instructions. Draft-review chat stays read-only and can add final corrections.
   Missing extraction explanations appear beside Save. Save private skill creates
   an ordinary private Cloud skill.
6. Fill in Starting page and the named inputs, then choose Run skill, or ask for
   the saved skill in chat. Workbot reads the saved instructions, asks for missing
   inputs, and operates through its existing browser tools. The chat shows the
   ordinary run request, not its internal input envelope. “No run verified” means
   saving alone does not establish a successful autonomous rerun.

The draft includes input placeholders, the taught controls and extraction
fields, teacher explanations, verification requirements, and interruption rules.
The latest explicit correction takes precedence. A selected step remains in chat
context even when it is older than the recent-action window. Repeated delivery
of one message adds its explanation once. Step-editor revisions prevent an open
editor from overwriting newer chat notes; Use current explanation refreshes it. Ambiguous people or records
require clarification. Page-derived descriptors are quoted untrusted data.
Navigation addresses are never recorded: even a hostname can carry a bearer
token. The compiled skill asks for a public `start_url` with each run. Explain
how to reach the task from that public starting page. Navigation after an
action describes its expected outcome; a rerun preserves the current search
rather than reopening the starting page after each action.

## Recording boundaries

Recording is limited to the chosen tab's top document and trusted user events.
With the browser live view, switching to another tab says that only the taught
tab is recorded, with Show taught tab to return to it. Closing the taught tab
pauses recording. It does not record other tabs, raw keystroke streams,
screenshots, entered field values, passwords, payment fields, or session
credentials. Extraction captures
an accessible field label or table heading rather than its example value.
An unlabeled selection keeps only its structural descriptor and asks for an
explanation; plain page-text clicks are not recorded as controls.
Page-script-generated clicks do not count as demonstrations. A bounded privacy
filter remembers observed field values only in guest memory for the current
demonstration, so labels that echo cleared or removed values remain redacted
across navigation. That history never enters draft storage or model context.
When its limit is reached, page-derived descriptors are concealed instead of
dropping older protections.

Navigation addresses, including hosts, paths, query strings, fragments and
embedded credentials, are omitted. Public control labels and teacher
explanations remain in the private draft: review these before saving or sharing.
The first version supports navigation, ordinary
text inputs, public select controls, clicks, Enter/Tab/Escape, and explicit
extraction targets. Frames, popups, canvas, contenteditable editors, file uploads,
and complex widget gestures need explanation or a separately taught workflow.

The guest stores the draft privately with its owning conversation. Recording
pauses on a lost teaching connection (a 12-second renewable lease) or at 120
steps. A guest process restart recovers a reviewable draft rather than resuming
recording with lost privacy history. Finish reviewing it or discard it to teach
again. Passive draft checks never wake or recreate a paused computer.
Switching workspace views preserves the teaching panel and its local review
fields. Opening the browser passively recovers an existing demonstration without
starting recording or waking a paused computer. Refreshing or reconnecting
recovers the recorded steps. A refresh does not restore unsaved name/purpose
fields or a local save receipt. The existing
conversation-computer retention policy applies to the draft. Cloud skills have
normal library retention and access rules.

Finish or discard the demonstration before returning the input rail to Workbot.
Stop and takeover remain authoritative during subsequent runs. Read-only
observations can be refreshed while navigation settles; uncertain dispatched
input is never automatically replayed. Turning teaching off denies new requests
and lease renewal while preserving the private draft and saved skills.
