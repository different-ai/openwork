#if OPENWORK_SPEECH_ANALYZER
import AVFoundation
import Foundation
import Speech

/// Live, on-device transcription. All session state belongs to the main
/// queue; conversion is serial and the input stream has a bounded backlog.
@available(macOS 26.0, *)
@MainActor
final class AnalyzerDictation: DictationSession {
  private let locale: Locale
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
  private var installationObservation: NSKeyValueObservation?
  private var installationPercent: Int?
  private var transcript = DictationTranscript()
  private var tapping = false
  private var stopping = false
  private var finished = false

  init(locale: Locale) {
    self.locale = locale
    // Favor live typing latency. Apple's smaller context window can trade some
    // accuracy for speed; tentative words remain revisable and Send finalizes.
    transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
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
        // Each short-lived helper must reserve the locale before checking it:
        // unreserved, already-downloaded assets otherwise report .supported.
        try await AssetInventory.reserve(locale: locale)
        let assetStatus = await AssetInventory.status(forModules: [transcriber])
        try Task.checkCancellation()
        guard !finished else { return }
        if assetStatus != .installed,
           let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
          try Task.checkCancellation()
          guard !finished else { return }
          installation = request
          emit(["type": "status", "status": "installing"])
          installationObservation = request.progress.observe(\.fractionCompleted, options: [.initial, .new]) { [weak self, weak request] progress, _ in
            let fraction = progress.fractionCompleted
            let percent = !progress.isIndeterminate && progress.totalUnitCount > 0 && fraction.isFinite
              ? Int((min(1, max(0, fraction)) * 100).rounded(.down)) : nil
            DispatchQueue.main.async {
              guard let self, let request, !self.finished, self.installation === request,
                    self.installationPercent != percent else { return }
              self.installationPercent = percent
              var event: [String: Any] = ["type": "status", "status": "installing"]
              if let percent { event["progress"] = Double(percent) / 100 }
              emit(event)
            }
          }
          try await request.downloadAndInstall()
          installationObservation?.invalidate(); installationObservation = nil
          guard !finished else { return }
          emit(["type": "status", "status": "installing", "progress": 1.0])
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
                // File acceptance checks follow the audio clock so first-word
                // latency measures live input rather than end-of-file flushing.
                Thread.sleep(forTimeInterval: Double(buffer.frameLength) / nativeFormat.sampleRate)
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
            if now - lastLevelAt >= 1.0 / 30 {
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
    installationObservation?.invalidate(); installationObservation = nil
    installation?.progress.cancel()
    installation = nil
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
