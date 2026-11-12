import AVFoundation
import Foundation
import Speech

// On-device dictation for the composer. Audio never leaves this Mac: recognition
// is required to run locally, nothing is written to disk, and the process exits
// when its parent closes stdin.
//
// stdout: one JSON object per line.
//   {"type":"ready"}                       listening started
//   {"type":"result","segments":[...]}     whole transcript so far, last segment still revisable
//   {"type":"level","level":0...1}         microphone amplitude, at most 20 Hz
//   {"type":"error","code":"..."}          Web Speech style error code
//   {"type":"end"}                         final result sent, exiting
// stdin: "stop" flushes the final words and ends; EOF cancels.

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

func words(_ text: String) -> [Substring] {
  text.split(whereSeparator: { $0.isWhitespace })
}

/// On-device recognition can start a fresh transcript after a pause without
/// marking the earlier one final. Treat a much shorter result with a different
/// first word as a new utterance so the earlier words are kept, not replaced.
func isRestart(previous: String, next: String) -> Bool {
  let before = words(previous), after = words(next)
  guard before.count >= 3, after.count * 2 <= before.count else { return false }
  return after.first?.lowercased() != before.first?.lowercased()
}

protocol DictationSession: AnyObject {
  @MainActor func stop()
  @MainActor func cancel()
}

final class Dictation: DictationSession {
  private let recognizer: SFSpeechRecognizer
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var committed: [String] = []
  private var partial = ""
  /// The recognizer's full text when the last utterance was committed; a later
  /// result that still repeats it carries only the remainder as new words.
  private var echo = ""
  private var startedAt = Date()
  private var stopping = false
  private var finished = false

  init(recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

  func start() throws {
    let input = engine.inputNode
    // Install the recognition request before accepting the first audio buffer.
    begin()
    var lastLevelAt: TimeInterval = 0
    input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
      self?.request?.append(buffer)
      let now = ProcessInfo.processInfo.systemUptime
      guard now - lastLevelAt >= 0.05 else { return }
      lastLevelAt = now
      let level = dictationAudioLevel(buffer)
      DispatchQueue.main.async {
        guard let self, !self.stopping, !self.finished else { return }
        emit(["type": "level", "level": level])
      }
    }
    engine.prepare()
    try engine.start()
    emit(["type": "ready"])
  }

  /// Recognition tasks end after silence or about a minute; the microphone keeps
  /// running and a new request continues the same transcript.
  private func begin() {
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.addsPunctuation = true
    request.taskHint = .dictation
    // Short, app-specific vocabulary improves recognition without rewriting
    // the user's meaning or sending a prompt to a language model.
    request.contextualStrings = ["OpenWork", "OpenCode", "Codex", "Claude", "GitHub",
      "TypeScript", "JavaScript", "OAuth", "API", "JSON", "localhost", "pull request"]
    self.request = request
    echo = ""
    startedAt = Date()
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async { self?.handle(request: request, result: result, error: error) }
    }
  }

  private func handle(request: SFSpeechAudioBufferRecognitionRequest, result: SFSpeechRecognitionResult?, error: Error?) {
    guard !finished, request === self.request else { return }
    if let result {
      var text = result.bestTranscription.formattedString
      if !echo.isEmpty, text.hasPrefix(echo) {
        text = String(text.dropFirst(echo.count)).trimmingCharacters(in: .whitespaces)
      } else if !partial.isEmpty, isRestart(previous: partial, next: text) {
        committed.append(partial)
      }
      partial = text
      if result.isFinal || result.speechRecognitionMetadata != nil {
        commitPartial()
        echo = result.bestTranscription.formattedString
      }
      sendResult()
      if result.isFinal { stopping ? finish() : begin() }
      return
    }
    guard error != nil else { return }
    commitPartial()
    sendResult()
    if stopping { return finish() }
    // A request that fails at once will keep failing; do not spin.
    if Date().timeIntervalSince(startedAt) < 1 {
      emit(["type": "error", "code": "network"])
      return finish()
    }
    begin()
  }

  private func commitPartial() {
    if !partial.isEmpty { committed.append(partial) }
    partial = ""
  }

  private func sendResult() {
    emit(["type": "result", "segments": partial.isEmpty ? committed : committed + [partial]])
  }

  func stop() {
    guard !stopping, !finished else { return }
    stopping = true
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    request?.endAudio()
    task?.finish()
    // Allow the final correction and punctuation to arrive. The renderer has a
    // longer watchdog; return the captured words if the speech service stalls.
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      guard let self, !self.finished else { return }
      emit(["type": "error", "code": "finalization-timeout"])
      self.finish()
    }
  }

  func finish() {
    guard !finished else { return }
    finished = true
    task?.cancel()
    if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
    commitPartial()
    sendResult()
    emit(["type": "end"])
    exit(0)
  }

  func cancel() { finish() }
}

func fail(_ code: String) -> Never {
  emit(["type": "error", "code": code])
  emit(["type": "end"])
  exit(0)
}

let arguments = CommandLine.arguments
let localeIndex = arguments.firstIndex(of: "--locale")
let localeIdentifier = localeIndex.flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil } ?? Locale.current.identifier

var dictation: DictationSession?

if !arguments.contains("--check") { Thread.detachNewThread {
  while let line = readLine() {
    if line.trimmingCharacters(in: .whitespaces) == "stop" { DispatchQueue.main.async { dictation?.stop() } }
  }
  DispatchQueue.main.async {
    guard let dictation else { exit(0) }
    dictation.cancel()
  }
} }

func startLegacy() {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)),
        recognizer.supportsOnDeviceRecognition else { fail("language-not-supported") }
  SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else { fail("service-not-allowed") }
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      DispatchQueue.main.async {
        guard granted else { fail("not-allowed") }
        let session = Dictation(recognizer: recognizer)
        dictation = session
        do { try session.start() } catch { fail("audio-capture") }
      }
    }
  }
}

Task { @MainActor in
  #if OPENWORK_SPEECH_ANALYZER
  if #available(macOS 26.0, *), SpeechTranscriber.isAvailable,
     let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeIdentifier)) {
    if arguments.contains("--check") {
      let module = SpeechTranscriber(locale: locale, preset: .transcription)
      let status = await AssetInventory.status(forModules: [module])
      emit(["type": "check", "onDevice": true, "engine": "SpeechAnalyzer", "assetsInstalled": status == .installed])
      exit(0)
    }
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      DispatchQueue.main.async {
        guard granted else { fail("not-allowed") }
        let session = AnalyzerDictation(locale: locale)
        dictation = session
        session.start()
      }
    }
    return
  }
  #endif
  if arguments.contains("--check") {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
    emit(["type": "check", "onDevice": recognizer?.supportsOnDeviceRecognition == true, "engine": "SFSpeechRecognizer"])
    exit(0)
  }
  startLegacy()
}

dispatchMain()
