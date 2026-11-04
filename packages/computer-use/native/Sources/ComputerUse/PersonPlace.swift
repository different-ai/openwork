import AppKit
import ApplicationServices

/// The person's place in the app they were using: read when the agent takes the
/// front, given back when it hands the front back. Reads roles, the focused window
/// and element and a text selection range only, never a field's value, and each
/// read is bounded so a busy app cannot hold the agent up.
@MainActor
enum PersonPlace {
    private static let timeout: Float = 0.2

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(element, timeout)
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private static func element(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
    private static func focused(_ pid: pid_t) -> AXUIElement? {
        element(attribute(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute))
    }
    private static func editsText(_ field: AXUIElement) -> Bool {
        SharedDesktop.editsText(role: attribute(field, kAXRoleAttribute) as? String,
            editableAncestor: attribute(field, "AXEditableAncestor") != nil)
    }
    /// An element that no longer exists has no role.
    private static func exists(_ element: AXUIElement) -> Bool { attribute(element, kAXRoleAttribute) != nil }

    /// Whether the app's focused element is a text field the person writes in.
    static func focusEditsText(_ pid: pid_t) -> Bool { focused(pid).map(editsText) ?? false }

    static func read(_ pid: pid_t) -> SharedDesktop.Place<AXUIElement> {
        var place = SharedDesktop.Place<AXUIElement>(pid: pid)
        place.window = element(attribute(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute))
        guard let field = focused(pid) else { return place }
        place.field = field
        place.inField = editsText(field)
        // A secure field's selection would tell how long its password is.
        guard place.inField, attribute(field, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else { return place }
        place.selection = selection(field)
        return place
    }

    /// A text element's selection (caret) range, never its value.
    static func selection(_ element: AXUIElement) -> CFRange? {
        guard let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cfRange, &range) ? range : nil
    }

    /// Their window back in front, their field focused and the caret where it was;
    /// whatever is gone falls back to activating the app, as before.
    @discardableResult
    static func restore(_ place: SharedDesktop.Place<AXUIElement>?, app: NSRunningApplication) -> SharedDesktop.Returned {
        let pid = app.processIdentifier
        return SharedDesktop.restore(place, activate: {
            _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            app.activate(options: [])
        }, raise: { window in
            guard exists(window), AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { return false }
            _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
            return true
        }, focus: { field in
            guard exists(field) else { return false }
            // Focusing a field that already has focus can select all of it in some apps.
            if let now = focused(pid), CFEqual(now, field) { return true }
            return AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
        }, select: { field, range in
            var range = range
            guard let value = AXValueCreate(.cfRange, &range) else { return }
            _ = AXUIElementSetAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, value)
        })
    }
}
