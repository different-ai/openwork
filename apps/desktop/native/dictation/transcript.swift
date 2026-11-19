import CoreMedia

/// Volatile results revise audio ranges, not just the last emitted string.
/// Keep the latest text for each range, including results that become final
/// without being reissued. SpeechAnalyzer finalizes the timeline at Stop.
struct DictationTranscript {
  private struct Segment {
    let range: CMTimeRange
    let text: String
  }
  private var timeline: [Segment] = []
  var segments: [String] { timeline.map(\.text) }

  mutating func update(range: CMTimeRange, text: String) {
    timeline.removeAll { segment in
      segment.range == range || (segment.range.start < range.end && range.start < segment.range.end)
    }
    if !text.isEmpty { timeline.append(Segment(range: range, text: text)) }
    timeline.sort { $0.range.start < $1.range.start }
  }
}
