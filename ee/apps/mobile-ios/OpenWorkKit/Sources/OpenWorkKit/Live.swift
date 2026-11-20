import Foundation

/// One message from a server-sent event stream.
public struct ServerSentEvent: Sendable, Equatable {
    public let event: String?
    public let data: String
}

/// Reads a server-sent event stream one line at a time.
///
/// Workbot sends each event's data as a single line of JSON, so an event is complete at its `data:` line. That
/// matters because `URLSession`'s line reader drops the blank lines that normally end an event.
public struct ServerSentEventReader: Sendable {
    private var pendingEvent: String?

    public init() {}

    public mutating func read(line: String) -> ServerSentEvent? {
        if line.isEmpty || line.hasPrefix(":") {
            return nil
        }
        if line.hasPrefix("event:") {
            pendingEvent = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            return nil
        }
        guard line.hasPrefix("data:") else { return nil }
        defer { pendingEvent = nil }
        return ServerSentEvent(event: pendingEvent, data: line.dropFirst(5).trimmingCharacters(in: .whitespaces))
    }
}

/// An answer as it streams in, for one message.
public struct LiveAnswer: Sendable, Equatable {
    /// The model call the newest words came from. A message can take several.
    public var step: Int
    public var text: String
    /// What earlier model calls of this message wrote, kept until the stored conversation has them.
    public var earlier: [String]
    /// Workbot is doing work rather than writing.
    public var working: Bool

    public init(step: Int, text: String = "", earlier: [String] = [], working: Bool = false) {
        self.step = step
        self.text = text
        self.earlier = earlier
        self.working = working
    }

    /// Everything streamed so far, oldest first.
    public var display: String {
        (earlier + [text]).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}

/// Live answers by message id.
public struct LiveAnswers: Sendable, Equatable {
    public private(set) var byMessage: [String: LiveAnswer] = [:]

    public init() {}

    public subscript(messageId: String) -> LiveAnswer? {
        byMessage[messageId]
    }

    /// Applies one event. Returns true when the stored conversation should be read again.
    @discardableResult
    public mutating func apply(_ event: LiveEvent) -> Bool {
        switch event {
        case .changed:
            return true
        case let .text(messageId, step, delta, reset):
            let previous = byMessage[messageId]
            if let previous, step < previous.step {
                return false
            }
            if let previous, previous.step == step {
                byMessage[messageId] = LiveAnswer(step: step, text: reset ? delta : previous.text + delta, earlier: previous.earlier)
            } else {
                byMessage[messageId] = LiveAnswer(step: step, text: delta, earlier: Self.earlier(after: previous))
            }
            return false
        case let .working(messageId, step):
            let previous = byMessage[messageId]
            if let previous, step < previous.step {
                return false
            }
            if let previous, previous.step == step {
                byMessage[messageId] = LiveAnswer(step: step, text: previous.text, earlier: previous.earlier, working: true)
            } else {
                byMessage[messageId] = LiveAnswer(step: step, earlier: Self.earlier(after: previous), working: true)
            }
            return false
        }
    }

    /// Drops live text for messages the stored conversation has finished, so nothing shows twice.
    public mutating func settle(with turns: [Turn]) {
        let active = Set(turns.filter(\.status.isActive).map(\.id))
        byMessage = byMessage.filter { active.contains($0.key) }
    }

    public mutating func removeAll() {
        byMessage.removeAll()
    }

    private static func earlier(after previous: LiveAnswer?) -> [String] {
        guard let previous else { return [] }
        return Array((previous.earlier + [previous.text]).filter { !$0.isEmpty }.suffix(3))
    }
}
