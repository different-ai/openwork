import AVFoundation
import Foundation

enum DictationAudioError: Error { case invalidFormat, conversionFailed, copyFailed }

/// One converter per recording. Consume on a serial queue and drain at Stop so
/// resampling never repeats a source buffer or drops its trailing samples.
final class DictationAudioConverter: @unchecked Sendable {
  // AVAudioConverter is mutable. Calls are serialized here even when callers
  // hand ownership from setup to the audio queue and then drain at Stop.
  private let lock = NSLock()
  private let converter: AVAudioConverter
  let format: AVAudioFormat

  init(from source: AVAudioFormat, to destination: AVAudioFormat) throws {
    guard source.sampleRate > 0, destination.sampleRate > 0,
          let converter = AVAudioConverter(from: source, to: destination) else {
      throw DictationAudioError.invalidFormat
    }
    self.converter = converter
    self.format = destination
  }

  func convert(_ input: AVAudioPCMBuffer) throws -> [AVAudioPCMBuffer] {
    lock.lock(); defer { lock.unlock() }
    var supplied = false
    return try drain(capacity: AVAudioFrameCount(ceil(Double(input.frameLength) * format.sampleRate / input.format.sampleRate)) + 64) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true
      status.pointee = .haveData
      return input
    }
  }

  func finish() throws -> [AVAudioPCMBuffer] {
    lock.lock(); defer { lock.unlock() }
    return try drain(capacity: 4096) { _, status in status.pointee = .endOfStream; return nil }
  }

  private func drain(capacity: AVAudioFrameCount, input: @escaping AVAudioConverterInputBlock) throws -> [AVAudioPCMBuffer] {
    var buffers: [AVAudioPCMBuffer] = []
    while true {
      guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: max(1, capacity)) else {
        throw DictationAudioError.conversionFailed
      }
      var error: NSError?
      let status = converter.convert(to: output, error: &error, withInputFrom: input)
      if let error { throw error }
      if status == .error { throw DictationAudioError.conversionFailed }
      if output.frameLength > 0 { buffers.append(output) }
      if status != .haveData { return buffers }
    }
  }
}

/// The engine reuses tap memory. Copy before handing a buffer to another queue.
func copyDictationAudio(_ source: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
  guard let owned = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength) else {
    throw DictationAudioError.copyFailed
  }
  owned.frameLength = source.frameLength
  let input = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: source.audioBufferList))
  let output = UnsafeMutableAudioBufferListPointer(owned.mutableAudioBufferList)
  for index in input.indices {
    guard let from = input[index].mData, let to = output[index].mData else { throw DictationAudioError.copyFailed }
    memcpy(to, from, Int(input[index].mDataByteSize))
  }
  return owned
}

func dictationAudioLevel(_ buffer: AVAudioPCMBuffer) -> Float {
  guard buffer.frameLength > 0, let samples = buffer.floatChannelData?[0] else { return 0 }
  var energy: Float = 0
  for index in 0..<Int(buffer.frameLength) { energy += samples[index] * samples[index] }
  let decibels = 20 * log10(max(sqrt(energy / Float(buffer.frameLength)), 0.000001))
  return min(1, max(0, (decibels + 60) / 48))
}
