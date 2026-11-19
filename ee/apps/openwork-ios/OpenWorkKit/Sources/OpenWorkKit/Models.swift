import Foundation

/// Who is signed in, from `GET /v1/workbot/me`.
public struct Me: Decodable, Sendable, Equatable {
    public let userId: String
    public let organizationId: String
    public let name: String
    public let email: String
    public let organizationName: String
    /// Workbot is on for this workspace.
    public let enabled: Bool
    /// The workspace allows Workbot on phones. A server that does not say so does not allow it.
    public let mobile: Bool

    public init(userId: String, organizationId: String, name: String, email: String, organizationName: String, enabled: Bool, mobile: Bool) {
        self.userId = userId
        self.organizationId = organizationId
        self.name = name
        self.email = email
        self.organizationName = organizationName
        self.enabled = enabled
        self.mobile = mobile
    }

    private enum CodingKeys: String, CodingKey { case userId, organizationId, name, email, organizationName, enabled, mobile }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        userId = try values.decode(String.self, forKey: .userId)
        organizationId = try values.decode(String.self, forKey: .organizationId)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
        email = try values.decodeIfPresent(String.self, forKey: .email) ?? ""
        organizationName = try values.decodeIfPresent(String.self, forKey: .organizationName) ?? ""
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        mobile = try values.decodeIfPresent(Bool.self, forKey: .mobile) ?? false
    }
}

public enum TurnStatus: String, Sendable, Equatable {
    case queued, working, done, failed, stopped

    public var isActive: Bool {
        self == .queued || self == .working
    }
}

/// Why Workbot's model could not answer. The phone only explains it; it never offers a purchase.
public enum ModelIssue: String, Sendable, Equatable {
    case freeLimit = "free_limit"
    case usageLimit = "usage_limit"
    case paymentRequired = "payment_required"
}

/// One piece of work Workbot did while answering, in plain words.
public struct WorkStep: Decodable, Sendable, Equatable {
    public let label: String
    public let running: Bool

    private enum CodingKeys: String, CodingKey { case label, status }

    public init(label: String, running: Bool) {
        self.label = label
        self.running = running
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        label = try values.decodeIfPresent(String.self, forKey: .label) ?? ""
        running = try (values.decodeIfPresent(String.self, forKey: .status)) == "running"
    }
}

public enum TurnPart: Sendable, Equatable {
    case text(String)
    case steps([WorkStep])
}

/// A file on a message. The first release names files; it does not open them.
public struct FileReference: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
}

/// A bigger job Workbot handed to the background.
public struct BackgroundTask: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let status: String

    public var isRunning: Bool {
        status == "queued" || status == "working" || status == "paused"
    }
}

/// One message from the person and Workbot's answer to it.
public struct Turn: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let text: String
    public let sentAt: Double?
    public var status: TurnStatus
    public let parts: [TurnPart]
    public var error: String?
    public let modelIssue: ModelIssue?
    public let retryable: Bool
    public let tasks: [BackgroundTask]
    /// Workbot spoke first, so there is no message from the person above the answer.
    public let greeting: Bool
    public let suggestions: [String]
    public let attachments: [FileReference]
    public let outputs: [FileReference]

    public init(
        id: String, text: String, sentAt: Double? = nil, status: TurnStatus, parts: [TurnPart] = [], error: String? = nil,
        modelIssue: ModelIssue? = nil, retryable: Bool = true, tasks: [BackgroundTask] = [], greeting: Bool = false,
        suggestions: [String] = [], attachments: [FileReference] = [], outputs: [FileReference] = []
    ) {
        self.id = id
        self.text = text
        self.sentAt = sentAt
        self.status = status
        self.parts = parts
        self.error = error
        self.modelIssue = modelIssue
        self.retryable = retryable
        self.tasks = tasks
        self.greeting = greeting
        self.suggestions = suggestions
        self.attachments = attachments
        self.outputs = outputs
    }

    private enum CodingKeys: String, CodingKey {
        case id, text, sentAt, status, parts, error, modelIssue, retryable, tasks, greeting, suggestions, attachments, outputs
    }

    private struct AnyPart: Decodable {
        let part: TurnPart?

        private enum CodingKeys: String, CodingKey { case kind, text, steps }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            switch try values.decodeIfPresent(String.self, forKey: .kind) {
            case "text": part = try .text(values.decodeIfPresent(String.self, forKey: .text) ?? "")
            case "steps": part = try .steps(values.decodeIfPresent([WorkStep].self, forKey: .steps) ?? [])
            // A newer server may send kinds this version does not draw.
            default: part = nil
            }
        }
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? ""
        sentAt = try values.decodeIfPresent(Double.self, forKey: .sentAt)
        status = try TurnStatus(rawValue: values.decodeIfPresent(String.self, forKey: .status) ?? "") ?? .done
        parts = try (values.decodeIfPresent([AnyPart].self, forKey: .parts) ?? []).compactMap(\.part)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        modelIssue = try (values.decodeIfPresent(String.self, forKey: .modelIssue)).flatMap(ModelIssue.init(rawValue:))
        retryable = try values.decodeIfPresent(Bool.self, forKey: .retryable) ?? true
        tasks = try values.decodeIfPresent([BackgroundTask].self, forKey: .tasks) ?? []
        greeting = try values.decodeIfPresent(Bool.self, forKey: .greeting) ?? false
        suggestions = try values.decodeIfPresent([String].self, forKey: .suggestions) ?? []
        attachments = try values.decodeIfPresent([FileReference].self, forKey: .attachments) ?? []
        outputs = try values.decodeIfPresent([FileReference].self, forKey: .outputs) ?? []
    }

    /// Workbot's stored words for this message, in order.
    public var answerText: String {
        parts.compactMap { part in
            if case let .text(text) = part {
                return text
            }
            return nil
        }
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")
    }

    /// What Workbot used while answering, without repeats, in the order it used them.
    public var workLabels: [String] {
        var seen = Set<String>()
        var labels: [String] = []
        for part in parts {
            guard case let .steps(steps) = part else { continue }
            for step in steps where !step.label.isEmpty && seen.insert(step.label).inserted {
                labels.append(step.label)
            }
        }
        return labels
    }
}

public enum UnavailableReason: String, Sendable, Equatable {
    case notEnabled = "workbot_not_enabled"
    case runnerUnavailable = "workbot_runner_unavailable"
    case modelUnavailable = "workbot_model_unavailable"
}

/// The conversation, from `GET /v1/workbot`.
public enum Conversation: Decodable, Sendable, Equatable {
    case unavailable(UnavailableReason)
    case available(turns: [Turn], busy: Bool, hasEarlier: Bool)

    private enum CodingKeys: String, CodingKey { case available, reason, turns, status, hasEarlier }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(Bool.self, forKey: .available) else {
            let reason = try UnavailableReason(rawValue: values.decodeIfPresent(String.self, forKey: .reason) ?? "")
            self = .unavailable(reason ?? .runnerUnavailable)
            return
        }
        self = try .available(
            turns: values.decodeIfPresent([Turn].self, forKey: .turns) ?? [],
            busy: (values.decodeIfPresent(String.self, forKey: .status)) == "busy",
            hasEarlier: values.decodeIfPresent(Bool.self, forKey: .hasEarlier) ?? false
        )
    }
}

/// What the live stream says while Workbot answers.
public enum LiveEvent: Decodable, Sendable, Equatable {
    /// Something about this message changed: read the conversation again.
    case changed(messageId: String)
    /// More of the answer. `reset` replaces what this model call wrote so far.
    case text(messageId: String, step: Int, delta: String, reset: Bool)
    /// Workbot is doing work for this message rather than writing.
    case working(messageId: String, step: Int)

    private enum CodingKeys: String, CodingKey { case type, messageId, step, delta, reset }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let messageId = try values.decode(String.self, forKey: .messageId)
        switch try values.decode(String.self, forKey: .type) {
        case "changed":
            self = .changed(messageId: messageId)
        case "text":
            self = try .text(
                messageId: messageId,
                step: values.decode(Int.self, forKey: .step),
                delta: values.decode(String.self, forKey: .delta),
                reset: values.decodeIfPresent(Bool.self, forKey: .reset) ?? false
            )
        case "working":
            self = try .working(messageId: messageId, step: values.decode(Int.self, forKey: .step))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: values, debugDescription: "unknown live event")
        }
    }
}
