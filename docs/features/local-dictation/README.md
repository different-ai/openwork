# Local dictation: record, then review

Feature: `nativeDictation` · cloud and self-hosted · off by default.
Author: reachjalil. This change does not change any live rollout.

On macOS 26 or later, supported devices and languages use Apple’s
`SpeechAnalyzer` with `SpeechTranscriber`. Older systems, unsupported hardware
and languages retain the on-device `SFSpeechRecognizer` fallback.

With the bundled speech helper, click the microphone, speak,
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

![Cancellable first-use model setup at 390 px](model-setup.png)

These screenshots render the real composer in an isolated browser harness.
Speech events are deterministic fixtures and model selection is omitted;
they show the interaction, not an acoustic accuracy result.

## Local recognition improvements

- Prefer the newer `SpeechTranscriber` model with the `.transcription` preset:
  finalized results, no fast or volatile guesses. `SpeechAnalyzer` consumes
  an asynchronous input stream and finalizes through the end of that stream
  before the completed transcript reaches the editor.
- Ask `AssetInventory` for the language asset and install it when needed.
  “Downloading speech model” is visible and cancellable; the microphone starts
  only after the model and analyzer are ready. The system shares and manages
  these assets. The first download needs a connection; transcription is local.
- Convert the microphone format into the analyzer’s chosen format, copy tap
  memory before queueing it, drain resampling at Stop, and reject an overloaded
  audio queue instead of silently dropping words.
- In the legacy fallback, create the recognition request before starting the audio engine, so the
  first buffer has a destination.
- Finish processing accepted audio after Stop and allow up to five seconds
  for final corrections and punctuation (previously 1.2 seconds). This is a
  maximum wait, not a fixed delay. A timeout retains captured text and asks
  the person to review it.
- In the legacy fallback, supply short recognition hints for OpenWork and common development terms,
  including OAuth, JSON and pull request. Apple documents these as improving
  the likelihood of recognizing domain vocabulary; no accuracy percentage
  is claimed here.
- Use the host's preferred language instead of the page's interface language.
- Derive a bounded 20 Hz level stream from the same audio tap. Only the
  waveform subscribes to level updates; the full composer does not rerender
  for every audio buffer.

Recognition still requires Apple’s on-device support for the language. A
failed model download or local start gives a recovery message rather than
silently switching to an online transcription service. No audio is saved or
uploaded, and no language model rewrites the transcript. Windows/browser speech and
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
without stopping an agent, and the existing live-recognition behavior. Native conversion tests cover 24/44.1/48 kHz stereo input, independent buffer
ownership, final samples, silence and level bounds. The Swift helper is built
with the macOS 14 deployment target; new APIs are guarded by macOS 26
availability. The build includes them when the selected SDK is 26 or newer,
and retains the legacy path for older SDKs. The isolated
composer is also checked at desktop and narrow widths and with reduced motion.
Packaged microphone/permission acceptance and measured speech accuracy remain
hardware checks; synthetic speech events do not establish either.

## Native smoke check

The production analyzer and converter were exercised on macOS 26.5 using a
synthesized English file, with no microphone recording. The run emitted model
installation, ready, finalized text, and end events successfully. The spoken
sample was “Please plan the week. Review the pull request, then check the OAuth
flow.” The result preserved the sentence but rendered “pull” as “pool” and
“OAuth” as “Ooth”. This proves native processing and finalization, not improved
recognition accuracy; technical vocabulary still needs real-speaker evaluation.
Apple documents `AnalysisContext.contextualStrings` for `DictationTranscriber`,
so the new `SpeechTranscriber` path does not claim those hints are supported.

Reproduce with `apps/desktop/test/native/speech-analyzer-smoke.swift`, compiled
alongside `native/dictation/audio-input.swift` and `speech-analyzer.swift` with
`-D OPENWORK_SPEECH_ANALYZER`. Pass a synthesized audio file. This is an opt-in
hardware check because Apple may download a system language asset; regular
native unit tests perform no downloads and never open the microphone.

## Acoustic comparison

Compare the legacy and new native flow
on the same consented audio set: ordinary prompts, accents, pauses, technical
names, and immediate Stop. Measure word error rate, final-word retention and
stop-to-text latency. Use those results to decide whether a bundled local model justifies its download, memory and language
coverage costs. Keep the recording/review interface independent of that choice.

References: [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer),
[SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber),
[AssetInventory](https://developer.apple.com/documentation/speech/assetinventory),
[Apple contextual vocabulary](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/contextualstrings),
[Apple finishing recognition](https://developer.apple.com/documentation/speech/sfspeechrecognitiontask/finish()),
[Claude dictation](https://code.claude.com/docs/en/voice-dictation),
and [Codex dictation](https://learn.chatgpt.com/docs/prompting#use-voice-dictation).
Design: P1, P5, P8, P11, S6, C6, V6, T5.
