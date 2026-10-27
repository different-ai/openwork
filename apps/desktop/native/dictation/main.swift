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

final class Dictation {
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
    input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
      self?.request?.append(buffer)
    }
    engine.prepare()
    try engine.start()
    begin()
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
    // Inside the composer's 1.5 s stop window, so the last words still land.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.finish() }
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
}

func fail(_ code: String) -> Never {
  emit(["type": "error", "code": code])
  emit(["type": "end"])
  exit(0)
}

let arguments = CommandLine.arguments
let localeIndex = arguments.firstIndex(of: "--locale")
let localeIdentifier = localeIndex.flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil } ?? Locale.current.identifier

if arguments.contains("--check") {
  let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
  emit(["type": "check", "onDevice": recognizer?.supportsOnDeviceRecognition == true])
  exit(0)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)),
      recognizer.supportsOnDeviceRecognition else { fail("language-not-supported") }

var dictation: Dictation?

Thread.detachNewThread {
  while let line = readLine() {
    if line.trimmingCharacters(in: .whitespaces) == "stop" { DispatchQueue.main.async { dictation?.stop() } }
  }
  DispatchQueue.main.async {
    guard let dictation else { exit(0) }
    dictation.finish()
  }
}

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

dispatchMain()
