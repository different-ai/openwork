import Foundation
import CoreGraphics

struct UseError: LocalizedError {
    let code: String
    let message: String
    let next: String
    init(_ code: String, _ message: String, next: String = "correct_request") {
        self.code = code; self.message = message; self.next = next
    }
    var errorDescription: String? { message }
    var payload: [String: Any] { ["ok": false, "code": code, "message": message, "next": next] }
}

enum AccessMode: String, CaseIterable {
    case observe, assist, control
    var title: String {
        switch self {
        case .observe: return "Read this window"
        case .assist: return "Use app controls"
        case .control: return "Use mouse and keyboard"
        }
    }
    var explanation: String {
        switch self {
        case .observe: return "Read window text and screenshots. No clicks or typing."
        case .assist: return "Read this window and use its accessible controls. Your pointer stays free."
        case .control: return "Read this window and use its controls, mouse and keyboard while it is in front. Local input pauses the session."
        }
    }
}

struct Arguments {
    let values: [String: Any]
    func only(_ keys: Set<String>) throws {
        guard Set(values.keys).isSubset(of: keys) else { throw UseError("invalid_arguments", "Unexpected argument. Read the tool schema.") }
    }
    func string(_ key: String, max: Int = 256) throws -> String {
        guard let value = values[key] as? String, !value.isEmpty, value.utf8.count <= max,
              !value.unicodeScalars.contains(where: { $0.value == 0 }) else {
            throw UseError("invalid_arguments", "\(key) must be a non-empty string of at most \(max) bytes.")
        }
        return value
    }
    func number(_ key: String, min: Double, max: Double) throws -> Double {
        guard let value = values[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, value.doubleValue >= min, value.doubleValue <= max else {
            throw UseError("invalid_arguments", "\(key) must be a finite number between \(min) and \(max).")
        }
        return value.doubleValue
    }
    func integer(_ key: String, min: Int, max: Int) throws -> Int {
        let value = try number(key, min: Double(min), max: Double(max))
        guard value.rounded() == value else { throw UseError("invalid_arguments", "\(key) must be an integer.") }
        return Int(value)
    }
    func bool(_ key: String, default fallback: Bool) throws -> Bool {
        guard let value = values[key] else { return fallback }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw UseError("invalid_arguments", "\(key) must be a boolean.")
        }
        return number.boolValue
    }
}

enum Action {
    case press(String), setValue(String, String), key(String), type(String)
    case click(CGPoint, Int), scroll(CGPoint, Int32, Int32), drag([CGPoint])

    init(_ values: [String: Any]) throws {
        let a = Arguments(values: values)
        let type = try a.string("type")
        switch type {
        case "press":
            try a.only(["type", "ref"]); self = .press(try a.string("ref"))
        case "set_value":
            try a.only(["type", "ref", "text"])
            // Empty text is a meaningful replacement.
            guard let text = values["text"] as? String, text.utf8.count <= 8_000, !text.contains("\0") else {
                throw UseError("invalid_arguments", "text must be a string of at most 8000 bytes.")
            }
            self = .setValue(try a.string("ref"), text)
        case "key":
            try a.only(["type", "key"])
            let key = try a.string("key")
            guard NativeKey.allowed.contains(key) else { throw UseError("unsupported_key", "Use one of the keys listed by computer_discover. System shortcuts are unavailable.") }
            self = .key(key)
        case "type":
            try a.only(["type", "text"]); self = .type(try a.string("text", max: 8_000))
        case "click", "double_click":
            try a.only(["type", "x", "y"]); self = .click(try Self.point(values), type == "click" ? 1 : 2)
        case "scroll":
            try a.only(["type", "x", "y", "delta_x", "delta_y"])
            self = .scroll(try Self.point(values), Int32(try a.integer("delta_x", min: -1200, max: 1200)), Int32(try a.integer("delta_y", min: -1200, max: 1200)))
        case "drag":
            try a.only(["type", "path"])
            guard let path = values["path"] as? [[String: Any]], (2...32).contains(path.count) else {
                throw UseError("invalid_arguments", "path needs 2–32 image points.")
            }
            self = .drag(try path.map { point in try Arguments(values: point).only(["x", "y"]); return try Self.point(point) })
        default: throw UseError("unknown_action", "Unsupported action. Read computer_act's schema.")
        }
    }
    private static func point(_ values: [String: Any]) throws -> CGPoint {
        let a = Arguments(values: values)
        return CGPoint(x: try a.number("x", min: 0, max: 100_000), y: try a.number("y", min: 0, max: 100_000))
    }
    var name: String {
        switch self {
        case .press: return "press"
        case .setValue: return "set_value"
        case .key: return "key"
        case .type: return "type"
        case .click(_, let count): return count == 1 ? "click" : "double_click"
        case .scroll: return "scroll"
        case .drag: return "drag"
        }
    }
    var requiresPointer: Bool {
        switch self { case .press, .setValue: return false; default: return true }
    }
}

enum NativeKey {
    // No global app switcher, launcher, pasteboard, permissions, or shell shortcuts.
    static let codes: [String: CGKeyCode] = ["enter": 36, "tab": 48, "escape": 53, "backspace": 51,
        "delete": 117, "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "page_up": 116, "page_down": 121, "space": 49]
    static let allowed = Set(codes.keys).union(["select_all", "undo", "redo"])
}

struct ObservationLease {
    let id: String
    let createdAt: TimeInterval
    let generation: Int
    let frame: CGRect
    let imageWidth: Int
    let imageHeight: Int
    var stateDigest: Data = Data()
    var imageDigest: Data?

    func validate(id requested: String, generation current: Int, frame currentFrame: CGRect, now: TimeInterval) throws {
        guard requested == id, generation == current, now - createdAt <= 15,
              now >= createdAt, frame == currentFrame else {
            throw UseError("stale_observation", "The window or observation changed. Observe again before acting.", next: "observe")
        }
    }
    func screenPoint(_ point: CGPoint) throws -> CGPoint {
        guard point.x.isFinite, point.y.isFinite, imageWidth > 0, imageHeight > 0,
              point.x >= 0, point.y >= 0, point.x < CGFloat(imageWidth), point.y < CGFloat(imageHeight) else {
            throw UseError("outside_window", "Coordinates must be inside the current observation image.", next: "observe")
        }
        return CGPoint(x: frame.minX + point.x * frame.width / CGFloat(imageWidth),
                       y: frame.minY + point.y * frame.height / CGFloat(imageHeight))
    }
}
