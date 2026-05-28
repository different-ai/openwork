import AppKit
import ApplicationServices

struct ElementFrame: Sendable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int

    var center: CGPoint {
        CGPoint(x: x + width / 2, y: y + height / 2)
    }

    var dictionary: [String: Any] {
        ["x": x, "y": y, "width": width, "height": height]
    }
}

struct AXElementState: Sendable {
    let enabled: Bool?
    let focused: Bool?
    let selected: Bool?
    let expanded: Bool?
    let checked: Bool?

    var dictionary: [String: Any] {
        var result: [String: Any] = [:]
        if let enabled { result["enabled"] = enabled }
        if let focused { result["focused"] = focused }
        if let selected { result["selected"] = selected }
        if let expanded { result["expanded"] = expanded }
        if let checked { result["checked"] = checked }
        return result
    }
}

struct AXElementCapabilities: Sendable {
    let canPress: Bool
    let canFocus: Bool
    let canScroll: Bool
    let canAdjust: Bool
    let canSetValue: Bool
    let actions: [String]

    var dictionary: [String: Any] {
        [
            "press": canPress,
            "focus": canFocus,
            "scroll": canScroll,
            "adjust": canAdjust,
            "setValue": canSetValue,
            "actions": actions,
        ]
    }
}

struct SemanticAXElement: Identifiable, Sendable {
    let id: Int
    let ref: String
    let role: String
    let label: String
    let value: String?
    let frame: ElementFrame
    let state: AXElementState
    let capabilities: AXElementCapabilities

    var dictionary: [String: Any] {
        var result: [String: Any] = [
            "id": id,
            "ref": ref,
            "role": role,
            "label": label,
            "frame": frame.dictionary,
            "state": state.dictionary,
            "capabilities": capabilities.dictionary,
        ]
        if let value { result["value"] = value }
        return result
    }
}

struct AXElementRecord: @unchecked Sendable {
    let element: AXUIElement
    let semantic: SemanticAXElement
}

struct ScreenshotMetadata: Sendable {
    let imageWidth: Int
    let imageHeight: Int
    let capturedBounds: CGRect

    var scaleX: CGFloat { capturedBounds.width / CGFloat(imageWidth) }
    var scaleY: CGFloat { capturedBounds.height / CGFloat(imageHeight) }

    func toScreen(imageX: Double, imageY: Double) -> CGPoint {
        CGPoint(
            x: capturedBounds.origin.x + imageX * scaleX,
            y: capturedBounds.origin.y + imageY * scaleY
        )
    }

    func toImage(point: CGPoint) -> CGPoint {
        CGPoint(
            x: (point.x - capturedBounds.origin.x) / scaleX,
            y: (point.y - capturedBounds.origin.y) / scaleY
        )
    }

    var dictionary: [String: Any] {
        [
            "imageWidth": imageWidth,
            "imageHeight": imageHeight,
            "capturedBounds": [
                "x": Int(capturedBounds.origin.x),
                "y": Int(capturedBounds.origin.y),
                "width": Int(capturedBounds.width),
                "height": Int(capturedBounds.height),
            ],
        ]
    }
}

struct WindowTarget: @unchecked Sendable {
    let appName: String
    let pid: pid_t
    let windowNumber: Int?
    let windowTitle: String?
    let bounds: CGRect
    let isFrontmost: Bool
    let axWindow: AXUIElement?

    var center: CGPoint {
        CGPoint(x: bounds.midX, y: bounds.midY)
    }
}

struct AppSnapshot: @unchecked Sendable {
    let id: String
    let observation: Int
    let appName: String
    let pid: pid_t
    let windowNumber: Int?
    let windowTitle: String?
    let screenshotData: Data
    let screenshotMimeType: String
    let screenshotMeta: ScreenshotMetadata
    let records: [AXElementRecord]
    let strictMode: Bool
    let backgroundActivated: Bool
    let recentActions: [String]
    let addedLabels: [String]
    let removedLabels: [String]

    var elements: [SemanticAXElement] {
        records.map(\.semantic)
    }

    func withSessionMetadata(id: String, observation: Int, recentActions: [String], addedLabels: [String], removedLabels: [String]) -> AppSnapshot {
        AppSnapshot(
            id: id,
            observation: observation,
            appName: appName,
            pid: pid,
            windowNumber: windowNumber,
            windowTitle: windowTitle,
            screenshotData: screenshotData,
            screenshotMimeType: screenshotMimeType,
            screenshotMeta: screenshotMeta,
            records: records,
            strictMode: strictMode,
            backgroundActivated: backgroundActivated,
            recentActions: recentActions,
            addedLabels: addedLabels,
            removedLabels: removedLabels
        )
    }
}

enum ExecutionPath: String {
    case accessibility = "accessibility"
    case backgroundCGEvent = "background_cgevent"
    case foregroundCGEvent = "foreground_cgevent"
    case none = "none"
}

struct ActionMetadata: Sendable {
    let ok: Bool
    let path: ExecutionPath
    let strictMode: Bool
    let backgroundSafe: Bool
    let fallbackUsed: Bool
    let message: String

    var dictionary: [String: Any] {
        [
            "ok": ok,
            "path": path.rawValue,
            "strictMode": strictMode,
            "backgroundSafe": backgroundSafe,
            "fallbackUsed": fallbackUsed,
            "message": message,
        ]
    }
}

enum ComputerUseError: LocalizedError {
    case accessibilityDenied
    case screenshotFailed
    case appNotFound(String)
    case noFrontmostApplication
    case noWindow(String)
    case noSnapshot
    case staleSnapshot(String)
    case invalidElement(String)
    case strictModeViolation(String)
    case eventSourceFailed
    case eventCreationFailed
    case unknownKey(String)

    var errorDescription: String? {
        switch self {
        case .accessibilityDenied:
            return "Accessibility permission is not granted."
        case .screenshotFailed:
            return "Screenshot capture failed."
        case .appNotFound(let name):
            return "App '\(name)' is not running."
        case .noFrontmostApplication:
            return "No frontmost application found."
        case .noWindow(let app):
            return "No usable window found for \(app)."
        case .noSnapshot:
            return "No snapshot is available. Call snapshot first."
        case .staleSnapshot(let reason):
            return "The last snapshot is stale. \(reason)"
        case .invalidElement(let ref):
            return "Element \(ref) was not found in the last semantic snapshot."
        case .strictModeViolation(let reason):
            return "Strict background mode rejected the action: \(reason)"
        case .eventSourceFailed:
            return "Failed to create CGEventSource."
        case .eventCreationFailed:
            return "Failed to create CGEvent."
        case .unknownKey(let key):
            return "Unknown key: \(key)"
        }
    }
}
