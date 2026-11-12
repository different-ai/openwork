# Local dictation: record, then review

Feature: `nativeDictation` · cloud and self-hosted · off by default.
Author: reachjalil. This change does not change any live rollout.

On macOS builds with the bundled speech helper, click the microphone, speak,
and press Stop (or Enter). The waveform responds to microphone amplitude;
interim recognition stays out of the editor. Once recognition finishes, the
transcript replaces the original selection or inserts at the original cursor.
Review or edit it, then choose Send. Cancel or Escape discards the recording.
Existing text and attachments stay in place. Editing the draft, changing chats,
hiding the app or disabling the feature cancels pending recognition, so late
words cannot overwrite newer work. Reduced motion replaces the moving meter
with a static Listening label.

![Recording in the composer](recording.png)

![Completed text ready to edit](finished.png)

These screenshots render the real composer in an isolated browser harness.
Speech events are deterministic fixtures and model selection is omitted;
they show the interaction, not an acoustic accuracy result.

## Local recognition improvements

- Create the recognition request before starting the audio engine, so the
  first buffer has a destination.
- Finish processing accepted audio after Stop and allow up to five seconds
  for final corrections and punctuation (previously 1.2 seconds). This is a
  maximum wait, not a fixed delay. A timeout retains captured text and asks
  the person to review it.
- Supply short recognition hints for OpenWork and common development terms,
  including OAuth, JSON and pull request. Apple documents these as improving
  the likelihood of recognizing domain vocabulary; no accuracy percentage
  is claimed here.
- Use the host's preferred language instead of the page's interface language.
- Derive a bounded 20 Hz level stream from the same audio tap. Only the
  waveform subscribes to level updates; the full composer does not rerender
  for every audio buffer.

Recognition still requires Apple's on-device support for the language. A
failed local start gives a recovery message rather than silently switching
transcription services. This does not install models, save audio, upload audio,
or rewrite the transcript with a language model. Windows/browser speech and
older builds' system-dictation handoff keep their existing behavior and do not
make an offline guarantee.

## Try and verify

Enable `nativeDictation` through the existing Features controls for a test
organization. Use a macOS build with its signed speech helper and microphone /
Speech Recognition permissions. Dictate a prompt with pauses and a technical
term, stop immediately after the last word, review, cancel a second recording,
and try editing the existing draft during a third recording.

Focused tests cover buffering and final corrections, selection insertion,
cancel/edit/revocation fencing, finite level events, Enter before Send, Escape
without stopping an agent, and the existing live-recognition behavior. The
Swift helper is typechecked for the macOS 14 deployment target. The isolated
composer is also checked at desktop and narrow widths and with reduced motion.
Packaged microphone/permission acceptance and measured speech accuracy remain
hardware checks; synthetic speech events do not establish either.

## Next quality decision

Before replacing the recognizer, compare the current and changed native flow
on the same consented audio set: ordinary prompts, accents, pauses, technical
names, and immediate Stop. Measure word error rate, final-word retention and
stop-to-text latency. Use those results to decide whether a newer native
recognizer or a bundled local model justifies its download, memory and language
coverage costs. Keep the recording/review interface independent of that choice.

References: [Apple contextual vocabulary](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/contextualstrings),
[Apple finishing recognition](https://developer.apple.com/documentation/speech/sfspeechrecognitiontask/finish()),
[Claude dictation](https://code.claude.com/docs/en/voice-dictation),
and [Codex dictation](https://learn.chatgpt.com/docs/prompting#use-voice-dictation).
Design: P1, P5, P8, P11, S6, C6, V6, T5.
