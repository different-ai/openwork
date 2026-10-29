# Dictation

Status: proposed, behind `nativeDictation`, off by default for cloud and
self-hosted deployments. Enable through the existing Features controls in
`/admin`; this change does not enable a live rollout.

## Experience

A plain microphone icon sits beside Send in OpenWork and Workbot. There is
no circular mic background, extra help panel, onboarding copy or review row.
An original waveform with two offset crests appears inline during dictation.
It responds to words arriving in the draft, settles between updates and
respects reduced-motion preferences. The existing draft stays editable.

| Surface | Dictation |
| --- | --- |
| OpenWork desktop on macOS | Opens macOS Dictation in the focused editor through AppKit; native controls own listening and Stop |
| OpenWork desktop on Windows | Opens Windows voice typing with its native Win+H chord; native controls own listening and Stop |
| Workbot and OpenWork in a supported browser | Starts the browser's SpeechRecognition implementation, showing live interim words directly in the draft; the mic stops dictation |
| Browser without speech recognition | Keeps the mic visible with its unavailable reason or native keyboard shortcut in its title; normal typing remains available |

In a browser, speech replaces the selected text or inserts at the cursor.
Revised interim results replace earlier words without duplication. The
microphone stops capture and keeps the transcript for editing. Send, or the
existing keyboard submission, commits the current interim words immediately
and stops that recognition session. Late recognition results cannot refill
the next draft. Typing an edit also stops the session so speech cannot
overwrite the person's changes. Speech never sends a message by itself.

The waveform marks dictation mode rather than measuring audio amplitude.
Browser capture state follows recognition start/end events; native desktop
listening remains visible in the operating system's own controls. Native
Dictation uses the system's configured language; browser recognition uses
the page or browser language. Permission and connection failures preserve
text and give a concise recovery instruction in the mic's title and an
accessible alert. There are no automatic capture retries.

## Privacy and rollout

The app installs no speech model and calls no application-owned transcription
endpoint. Desktop dictation is processed by the OS; browser recognition is
processed by the browser's implementation and may use its online speech
service. This is not an offline guarantee. The app stores no audio and the
waveform opens no second microphone stream. Only the resulting text enters
normal draft and message handling. The browser's own microphone consent
remains required.

The server resolves the registry flag for the current organization. Missing
flags are off. Signed-out OpenWork follows the deployment flag. Disabling
it aborts browser capture and pending desktop launches without deleting
text or attachments. An already-open native dictation panel remains under
the person's OS controls. Workbot refreshes enabled feature state every minute.

Desktop launches require the focused trusted main frame. Windows rechecks
foreground process ownership immediately before its fixed chord and refuses
to inject while modifier keys are held. The renderer cannot supply arbitrary
commands, keys, text or target processes.

## Verification boundaries

The PR proof drives the real Workbot UI with a deterministic speech-event
fixture: flag off, direct live draft, interim revisions, inline waveform,
narrow layout, Send while transcribing, late-result rejection, Stop and edit.
It does not claim acoustic accuracy or permission-prompt coverage. Focused
adapter tests cover frame/focus rejection and cancellation. Real speech
accuracy, browser/vendor availability and packaged macOS/Windows acceptance
remain hardware checks before rollout.

Design follows P1, P5, P8, P11, S6, C6, V5, V6 and T5 in `DESIGN.md`.
References: [Apple Dictation](https://support.apple.com/guide/mac-help/mh40584/mac),
[Windows voice typing](https://support.microsoft.com/en-us/accessibility/windows/use-voice-typing-to-talk-instead-of-type-on-your-pc),
and the [Web Speech API](https://webaudio.github.io/web-speech-api/).
