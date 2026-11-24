import Foundation
import Observation

/// Why a message did not send. The screen puts each into words.
public enum SendProblem: Equatable, Sendable {
    case tooLong
    case sendingTooFast
    case tooManyWaiting
    case offline
    case cannotReach
    case refused(String?)
}

/// The one conversation with Workbot: what is stored, what is streaming, and what the person just sent.
@MainActor
@Observable
public final class ChatModel {
    public enum LoadState: Equatable, Sendable {
        case loading
        case ready
        case unavailable(UnavailableReason)
        case failed(offline: Bool)
    }

    /// The most one message can carry (the server's limit).
    public static let maxMessageLength = 100_000

    public private(set) var state: LoadState = .loading
    /// Stored turns, then anything sent that the server has not listed yet.
    public private(set) var turns: [Turn] = []
    public private(set) var live = LiveAnswers()
    /// Messages that did not send, by id.
    public private(set) var sendProblems: [String: SendProblem] = [:]
    /// The conversation was shown, but the last read failed.
    public private(set) var connectionLost = false
    public private(set) var isStopping = false

    /// A message that has not reached the server: it can be sent again as the same message.
    public func isUnsent(_ turn: Turn) -> Bool {
        pending.contains { $0.id == turn.id }
    }

    /// Workbot is answering, or has messages waiting.
    public var isBusy: Bool {
        serverBusy || turns.contains { $0.status.isActive }
    }

    @ObservationIgnored public var onSignedOut: (() -> Void)?
    @ObservationIgnored public var onPhoneNotEnabled: (() -> Void)?

    private let client: WorkbotClient
    private let pause: @Sendable (Duration) async -> Void
    private var stored: [Turn] = []
    private var pending: [Turn] = []
    private var serverBusy = false
    private var liveTask: Task<Void, Never>?
    private var reading = false
    private var readAgain = false

    public init(client: WorkbotClient, pause: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
        self.client = client
        self.pause = pause
    }

    // MARK: Showing the conversation

    /// Starts reading and listening. Call when the conversation comes on screen; live updates run only in front.
    public func activate() {
        guard liveTask == nil else { return }
        liveTask = Task { [weak self] in await self?.listen() }
    }

    public func deactivate() {
        liveTask?.cancel()
        liveTask = nil
    }

    /// Forgets everything, for sign-out.
    public func reset() {
        deactivate()
        stored = []
        pending = []
        turns = []
        live.removeAll()
        sendProblems = [:]
        serverBusy = false
        connectionLost = false
        state = .loading
    }

    public func load() async {
        do {
            switch try await client.conversation() {
            case let .unavailable(reason):
                state = .unavailable(reason)
            case let .available(turns, busy, _):
                stored = turns
                serverBusy = busy
                pending.removeAll { sent in turns.contains { $0.id == sent.id } }
                live.settle(with: turns)
                connectionLost = false
                state = .ready
                merge()
            }
        } catch {
            guard !handled(error) else { return }
            if state == .ready {
                connectionLost = true
            } else {
                state = .failed(offline: error as? APIFailure == .offline)
            }
        }
    }

    // MARK: Sending

    public func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let turn = Turn(id: MessageID.make(), text: trimmed, sentAt: Date().timeIntervalSince1970 * 1000, status: .queued)
        pending.append(turn)
        merge()
        await deliver(turn)
    }

    /// Sends a message that did not go through, again, as the same message.
    public func sendAgain(_ turn: Turn) async {
        guard let index = pending.firstIndex(where: { $0.id == turn.id }) else { return }
        sendProblems[turn.id] = nil
        pending[index].status = .queued
        merge()
        await deliver(pending[index])
    }

    /// Answers a stored message whose answer failed, in place.
    public func retry(_ turn: Turn) async {
        do {
            try await client.retry(id: turn.id)
            await load()
        } catch {
            guard !handled(error) else { return }
            sendProblems[turn.id] = Self.problem(error)
        }
    }

    public func stop() async {
        guard !isStopping else { return }
        isStopping = true
        defer { isStopping = false }
        do {
            try await client.stop()
        } catch {
            if handled(error) {
                return
            }
        }
        await load()
    }

    private func deliver(_ turn: Turn) async {
        guard turn.text.count <= Self.maxMessageLength else {
            fail(turn, .tooLong)
            return
        }
        do {
            try await client.send(id: turn.id, text: turn.text)
            requestRead()
        } catch {
            guard !handled(error) else { return }
            fail(turn, Self.problem(error))
        }
    }

    private func fail(_ turn: Turn, _ problem: SendProblem) {
        guard let index = pending.firstIndex(where: { $0.id == turn.id }) else { return }
        pending[index].status = .failed
        sendProblems[turn.id] = problem
        merge()
    }

    private static func problem(_ error: any Error) -> SendProblem {
        switch error as? APIFailure {
        case .offline: .offline
        case let .refused(status, code, message):
            if code == "message_too_long" {
                .tooLong
            } else if status == 429 {
                code == "rate_limited" ? .sendingTooFast : .tooManyWaiting
            } else {
                .refused(message)
            }
        default: .cannotReach
        }
    }

    // MARK: Live updates

    private func listen() async {
        var failures = 0
        await load()
        while !Task.isCancelled {
            do {
                let events = try await client.events()
                failures = 0
                // Anything missed while not listening is picked up by one read.
                requestRead()
                for try await event in events where live.apply(event) {
                    requestRead()
                }
            } catch {
                if handled(error) || Task.isCancelled {
                    return
                }
                failures += 1
            }
            if Task.isCancelled {
                return
            }
            // The server ends a healthy stream every few minutes; only failures wait longer.
            await pause(.milliseconds(failures == 0 ? 300 : min(failures * 1500, 10000)))
            if failures > 0 {
                await load()
            }
        }
    }

    /// Reads the conversation without holding up live text; reads asked for meanwhile collapse into one more.
    private func requestRead() {
        if reading {
            readAgain = true
            return
        }
        reading = true
        Task { [weak self] in
            repeat {
                self?.readAgain = false
                await self?.load()
            } while self?.readAgain == true && !Task.isCancelled
            self?.reading = false
        }
    }

    private func merge() {
        turns = stored + pending.filter { sent in !stored.contains { $0.id == sent.id } }
    }

    /// Failures that change where the app is, rather than what the conversation shows.
    private func handled(_ error: any Error) -> Bool {
        if error is CancellationError {
            return true
        }
        switch error as? APIFailure {
        case .signedOut:
            onSignedOut?()
            return true
        case .phoneNotEnabled:
            onPhoneNotEnabled?()
            return true
        default:
            return false
        }
    }
}
