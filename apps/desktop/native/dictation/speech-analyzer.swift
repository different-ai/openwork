#if OPENWORK_SPEECH_ANALYZER
import AVFoundation
import Foundation
import Speech

/// Live, on-device transcription. All session state belongs to the main
/// queue; conversion is serial and the input stream has a bounded backlog.
@available(macOS 26.0, *)
@MainActor
final class AnalyzerDictation: DictationSession {
  private let transcriber: SpeechTranscriber
  private let analyzer: SpeechAnalyzer
  private let engine = AVAudioEngine()
  private let audioQueue = DispatchQueue(label: "openwork.dictation.audio")
  private let input = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .bufferingOldest(256))
  private var converter: DictationAudioConverter?
  private var startup: Task<Void, Never>?
  private var results: Task<Void, Error>?
  private var completion: Task<Void, Never>?
  private var installation: AssetInstallationRequest?
  private var transcript = DictationTranscript()
  private var tapping = false
  private var stopping = false
  private var finished = false

  init(locale: Locale) {
    // Show tentative words while retaining the model's full-context final pass.
    // fastResults is intentionally absent: Send waits for finalized results.
    transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
    analyzer = SpeechAnalyzer(modules: [transcriber])
  }

  // File input exercises the same converter, stream and finalization in native
  // acceptance tests without recording a person's microphone. IPC uses the mic.
  func start(audioFile: AVAudioFile? = nil) {
    startup = Task { @MainActor [weak self] in
      guard let self else { return }
      var assetsReady = false
      do {
        try Task.checkCancellation()
        guard !finished else { return }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
          try Task.checkCancellation()
          guard !finished else { return }
          installation = request
          emit(["type": "status", "status": "installing"])
          try await request.downloadAndInstall()
          installation = nil
        }
        assetsReady = true
        try Task.checkCancellation()
        guard !finished else { return }
        let nativeFormat = audioFile?.processingFormat ?? engine.inputNode.outputFormat(forBus: 0)
        guard nativeFormat.sampleRate > 0, nativeFormat.channelCount > 0,
              let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: nativeFormat) else {
          throw DictationAudioError.invalidFormat
        }
        let converter = try DictationAudioConverter(from: nativeFormat, to: format)
        self.converter = converter
        try await analyzer.prepareToAnalyze(in: format)
        try Task.checkCancellation()
        guard !finished else { return }
        results = Task { @MainActor [weak self] in
          guard let self else { return }
          for try await result in transcriber.results {
            guard !finished else { return }
            transcript.update(range: result.range, text: String(result.text.characters))
            emit(["type": "result", "segments": transcript.segments])
          }
        }
        try await analyzer.start(inputSequence: input.stream)
        try Task.checkCancellation()
        guard !finished else { return }
        // Closing AsyncStream alone does not finalize a SpeechAnalyzer session.
        completion = Task { @MainActor [weak self] in
          guard let self else { return }
          do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await results?.value
            finish(error: transcript.segments.isEmpty ? "no-speech" : nil)
          } catch { if !finished { finish(error: "network") } }
        }
        if let audioFile {
          emit(["type": "ready"])
          audioQueue.async { [weak self] in
            guard let self else { return }
            do {
              while audioFile.framePosition < audioFile.length {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: nativeFormat, frameCapacity: 4096) else { throw DictationAudioError.copyFailed }
                try audioFile.read(into: buffer)
                try enqueue(converter.convert(buffer))
              }
              try enqueue(converter.finish())
              input.continuation.finish()
            } catch { DispatchQueue.main.async { self.finish(error: "audio-capture") } }
          }
          return
        }
        var lastLevelAt: TimeInterval = 0
        engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: nativeFormat) { [weak self] buffer, _ in
          guard let self else { return }
          do {
            let owned = try copyDictationAudio(buffer)
            audioQueue.async { [weak self] in
              guard let self else { return }
              do { try enqueue(converter.convert(owned)) }
              catch { DispatchQueue.main.async { self.finish(error: "audio-capture") } }
            }
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastLevelAt >= 0.05 {
              lastLevelAt = now
              let level = dictationAudioLevel(buffer)
              DispatchQueue.main.async {
                guard !self.stopping, !self.finished else { return }
                emit(["type": "level", "level": level])
              }
            }
          } catch { DispatchQueue.main.async { self.finish(error: "audio-capture") } }
        }
        tapping = true
        engine.prepare()
        try engine.start()
        emit(["type": "ready"])
      } catch {
        if !finished { finish(error: assetsReady ? "audio-capture" : "model-unavailable") }
      }
    }
  }

  nonisolated private func enqueue(_ buffers: [AVAudioPCMBuffer]) throws {
    for buffer in buffers {
      // Never silently lose words if recognition cannot keep up with capture.
      if case .dropped = input.continuation.yield(AnalyzerInput(buffer: buffer)) {
        throw DictationAudioError.conversionFailed
      }
    }
  }

  private func stopMicrophone() {
    engine.stop()
    if tapping { engine.inputNode.removeTap(onBus: 0); tapping = false }
  }

  func stop() {
    guard !stopping, !finished else { return }
    stopping = true
    stopMicrophone()
    let converter = self.converter
    audioQueue.async { [weak self] in
      guard let self else { return }
      do { if let converter { try enqueue(converter.finish()) } }
      catch { DispatchQueue.main.async { self.finish(error: "audio-capture") } }
      input.continuation.finish()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      guard let self, !finished else { return }
      finish(error: "finalization-timeout")
    }
  }

  func cancel() {
    guard !finished else { return }
    finished = true
    stopMicrophone()
    installation?.progress.cancel()
    startup?.cancel(); completion?.cancel(); results?.cancel()
    input.continuation.finish()
    Task { await analyzer.cancelAndFinishNow(); exit(0) }
  }

  private func finish(error: String?) {
    guard !finished else { return }
    emit(["type": "result", "segments": transcript.segments])
    if let error { emit(["type": "error", "code": error]) }
    emit(["type": "end"])
    cancel()
  }
}
#endif
