import AVFoundation
import CoreMedia
import Foundation

@main struct DictationAudioTests {
  static func main() throws {
    var transcript = DictationTranscript()
    func range(_ start: Int64, _ end: Int64) -> CMTimeRange {
      CMTimeRange(start: CMTime(value: start, timescale: 10), end: CMTime(value: end, timescale: 10))
    }
    transcript.update(range: range(0, 10), text: "Plan the weak")
    transcript.update(range: range(0, 12), text: "Plan the week.")
    transcript.update(range: range(12, 20), text: "Review it")
    precondition(transcript.segments == ["Plan the week.", "Review it"], "Revisions must replace, not duplicate, words")
    transcript.update(range: range(12, 22), text: "Review the changes.")
    precondition(transcript.segments == ["Plan the week.", "Review the changes."], "Adjacent ranges must remain intact")
    transcript.update(range: range(22, 24), text: "noise")
    transcript.update(range: range(22, 24), text: "")
    precondition(transcript.segments.count == 2, "An empty revision removes just its own range")
    transcript.update(range: range(0, 22), text: "Plan the week. Review the changes.")
    precondition(transcript.segments == ["Plan the week. Review the changes."], "A merged range replaces every overlapping hypothesis")
    for rate in [24000.0, 44100.0, 48000.0] {
      let source = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2)!
      let target = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
      let converter = try DictationAudioConverter(from: source, to: target)
      var output: [AVAudioPCMBuffer] = []
      // A second of quiet audio followed by a 100 ms tone: the tail must survive
      // resampling and draining, without repeating one buffer over and over.
      let total = Int(rate * 1.1)
      var offset = 0
      while offset < total {
        let count = min(1024, total - offset)
        let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(count))!
        input.frameLength = AVAudioFrameCount(count)
        for channel in 0..<2 {
          for index in 0..<count {
            input.floatChannelData![channel][index] = offset + index < Int(rate) ? 0 : 0.5 * sin(Float(offset + index) * 2 * .pi * 440 / Float(rate))
          }
        }
        let owned = try copyDictationAudio(input)
        let expectedFirst = owned.floatChannelData![0][0]
        input.floatChannelData![0][0] = 99
        precondition(owned.floatChannelData![0][0] == expectedFirst, "The tap copy must own its samples")
        output += try converter.convert(owned)
        offset += count
      }
      output += try converter.finish()
      let samples = output.flatMap { buffer in Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))) }
      precondition(abs(samples.count - 17600) < 40, "Unexpected duration after converting \(rate): \(samples.count)")
      precondition(samples.prefix(15000).allSatisfy { abs($0) < 0.001 }, "Silence must remain silence")
      precondition(samples.suffix(1000).contains { abs($0) > 0.2 }, "Stop must retain the final tone")
      precondition(output.allSatisfy { $0.format.sampleRate == 16000 && $0.format.channelCount == 1 })
    }
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    let audio = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
    audio.frameLength = 1024
    for index in 0..<1024 { audio.floatChannelData![0][index] = 0 }
    precondition(dictationAudioLevel(audio) == 0)
    for index in 0..<1024 { audio.floatChannelData![0][index] = 0.5 }
    precondition(dictationAudioLevel(audio) == 1)
    print("PASS: 24/44.1/48 kHz stereo conversion, owned buffers, final samples, silence and level bounds")
  }
}
