// Opt-in hardware smoke: compile with the production analyzer and converter,
// then pass a synthesized audio file. Downloads Apple's language asset if needed;
// does not open the microphone. Not part of the network-free unit test command.
import AVFoundation
import Foundation
import Speech

protocol DictationSession: AnyObject { @MainActor func stop(); @MainActor func cancel() }
func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  print(String(data: data, encoding: .utf8)!)
}

@main struct AnalyzerSmoke {
  @MainActor static var retained: AnyObject?
  static func main() {
    setvbuf(stdout, nil, _IOLBF, 0)
    guard CommandLine.arguments.count == 2 else { fatalError("Pass a synthesized audio file") }
    Task { @MainActor in
      guard #available(macOS 26.0, *), SpeechTranscriber.isAvailable,
            let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
        fatalError("SpeechTranscriber is not supported here")
      }
      do {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[1]))
        let session = AnalyzerDictation(locale: locale)
        retained = session
        session.start(audioFile: file)
      } catch { fatalError("Could not open the synthesized audio: \(error)") }
    }
    dispatchMain()
  }
}
