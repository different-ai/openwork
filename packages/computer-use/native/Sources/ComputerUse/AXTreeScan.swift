import ApplicationServices
import CryptoKit
import Foundation

/// The attribute reads a window scan makes. `MacAccessibility` reads the live
/// accessibility tree under its time budget; tests supply synthetic trees.
/// `subrole` is a display-only read used to order children; `isProtected`
/// takes that read for a group (where it is display-only too) and otherwise
/// reads the subrole itself, so masks are decided by the same strict reads.
struct AXTreeReader {
    var role: (AXUIElement) throws -> String?
    var subrole: (AXUIElement) throws -> String?
    var isProtected: (AXUIElement, _ role: String, _ subrole: String??) throws -> Bool
    var isSecureTextField: (AXUIElement, _ role: String) throws -> Bool
    var frame: (AXUIElement) throws -> CGRect?
    /// Display-only string and flag reads (title, description, value, enabled).
    var text: (AXUIElement, String) throws -> String?
    var flag: (AXUIElement, String) throws -> Bool?
    var actions: (AXUIElement) throws -> [String]
    var settable: (AXUIElement) throws -> Bool
    var children: (AXUIElement, _ limit: Int, _ check: () throws -> Void) throws -> AXChildrenSnapshot
    var focused: (_ window: AXUIElement) throws -> AXUIElement?
    var checkBudget: () throws -> Void
}

/// Walks one window's accessibility tree for its listing and protected-field masks.
///
/// Every element is read, or the scan reports `tree_limit` and the image is withheld.
/// Web pages nest deeply (Chrome's frame alone uses several levels before page content),
/// so the limits fit large single-page apps; the read's time budget is the real cap.
/// A branch past the depth limit is skipped and the rest of the window is still listed,
/// but the image stays withheld because that branch was never checked for passwords.
/// Dialogs and sheets are visited before their siblings, so a modal opened over a large
/// page is listed before the 300-element listing cap or any limit is reached.
enum AXTreeScan {
    static let maxDepth = 64
    static let maxElements = 5_000
    static let listLimit = 300

    static let dialogRoles: Set<String> = ["AXSheet", "AXDialog"]
    static let dialogSubroles: Set<String> = ["AXApplicationDialog", "AXApplicationAlertDialog", "AXDialog", "AXSystemDialog"]
    /// Only a group's subrole is read ahead to find web dialogs (`role="dialog"` in Chrome).
    static func readsSubroleAhead(role: String?) -> Bool { role == "AXGroup" }
    static func isDialog(role: String?, subrole: String?) -> Bool {
        role.map(dialogRoles.contains) == true || subrole.map(dialogSubroles.contains) == true
    }
    /// Dialogs first, otherwise the app's order.
    static func ordered<T>(_ items: [T], isDialog: (T) -> Bool) -> [T] {
        items.filter(isDialog) + items.filter { !isDialog($0) }
    }

    static func textHash(_ text: String) -> Data { Data(SHA256.hash(data: Data(text.utf8))) }

    private struct Pending {
        let element: AXUIElement
        let depth: Int
        let parentFrame: CGRect?
        /// Read when the parent listed its children; nil for the window itself.
        let role: String?
        let subrole: String??
    }

    @MainActor
    static func run(_ window: AXUIElement, reader: AXTreeReader, check: () throws -> Void = {}) async throws -> WindowState {
        var records: [ElementRecord] = []
        var protectedFrames: [CGRect] = []
        var visited: Set<AXUIElement> = []
        var pending: [Pending] = [Pending(element: window, depth: 0, parentFrame: nil, role: nil, subrole: .none)]
        var issue: String?
        var listCapped = false
        var focused: AXUIElement?
        var childSnapshots: [AXChildrenSnapshot] = []
        while let next = pending.popLast() {
            try Task.checkCancellation(); try check()
            let element = next.element
            // Only the scan limits withhold the image. Past the listing limit the scan
            // continues for protected fields, and the listing is marked truncated.
            guard visited.count < maxElements else { issue = "tree_limit"; break }
            // Too deep to verify: skip this branch, keep listing the rest, withhold the image.
            guard next.depth < maxDepth else { issue = "tree_limit"; continue }
            guard visited.insert(element).inserted else { continue }
            do {
                try reader.checkBudget()
                guard let role = try next.role ?? reader.role(element) else {
                    throw UseError("accessibility_unavailable", "An accessible role could not be verified.", next: "observe")
                }
                let secure = try reader.isProtected(element, role, next.subrole)
                let bounds = try reader.frame(element)
                if secure {
                    guard let bounds, Geometry.valid(bounds) else {
                        throw UseError("missing_secure_mask", "A protected control has no usable mask.", next: "observe")
                    }
                    protectedFrames.append(bounds)
                    // A password the person gave can be typed here. The field stays masked
                    // in every image and its value is never read.
                    if try reader.isSecureTextField(element, role) {
                        let label = try reader.text(element, kAXTitleAttribute) ?? reader.text(element, kAXDescriptionAttribute) ?? ""
                        let enabled = try reader.flag(element, kAXEnabledAttribute) != false
                        records.append(.secureField(ref: "e\(records.count + 1)", element: element, role: role, labelHash: textHash(label),
                            frame: bounds, actions: try reader.actions(element), settable: try reader.settable(element), enabled: enabled))
                    }
                } else {
                    let rawLabel = try reader.text(element, kAXTitleAttribute) ?? reader.text(element, kAXDescriptionAttribute) ?? ""
                    var label = rawLabel
                    if label.isEmpty, role == "AXButton",
                       let name = ElementRecord.windowButtonLabel(subrole: try reader.text(element, kAXSubroleAttribute)) {
                        label = name
                    }
                    let value = try reader.text(element, kAXValueAttribute)
                    let actions = try reader.actions(element)
                    let settable = try reader.settable(element)
                    let enabled = try reader.flag(element, kAXEnabledAttribute) != false
                    if let bounds, Geometry.valid(bounds), !label.isEmpty || !(value ?? "").isEmpty || !actions.isEmpty || settable || ElementRecord.interactiveRoles.contains(role),
                       !ElementRecord.isClutter(role: role, label: label, value: value, frame: bounds, parentFrame: next.parentFrame) {
                        if records.count < listLimit {
                            // The hash is of the raw AX text, so validation reads compare like with like.
                            records.append(ElementRecord(ref: "e\(records.count + 1)", element: element, role: role,
                                label: String(label.prefix(180)), value: value.map { String($0.prefix(500)) }, frame: bounds,
                                actions: actions, settable: settable, enabled: enabled, protected: false,
                                labelHash: textHash(rawLabel), valueHash: value.map(textHash)))
                        } else { listCapped = true }
                    }
                    let descendants = try reader.children(element, maxElements - visited.count - pending.count, check)
                    childSnapshots.append(descendants)
                    if descendants.truncated { issue = "tree_limit" }
                    var listed: [Pending] = []
                    for child in descendants.elements {
                        let childRole = try reader.role(child)
                        let childSubrole: String?? = readsSubroleAhead(role: childRole) ? .some(try reader.subrole(child)) : .none
                        listed.append(Pending(element: child, depth: next.depth + 1, parentFrame: bounds, role: childRole, subrole: childSubrole))
                    }
                    // The stack pops from its end: push in reverse so the first to visit is last.
                    pending += ordered(listed) { isDialog(role: $0.role, subrole: $0.subrole ?? nil) }.reversed()
                }
            } catch is CancellationError { throw CancellationError() }
            catch {
                issue = (error as? UseError)?.code ?? "accessibility_unavailable"
                break
            }
            await Task.yield()
        }
        try check()
        if issue == nil {
            do {
                // Revalidate the exact ordered child lists after traversal.
                // Counts alone miss insert/remove/reorder mutations of equal size.
                for snapshot in childSnapshots {
                    let current = try reader.children(snapshot.parent, snapshot.elements.count, check)
                    try AXChildScan.requireStable(expectedCount: snapshot.total, currentCount: current.total,
                                                  expected: snapshot.elements, current: current.elements)
                }
                focused = try reader.focused(window)
            } catch is CancellationError { throw CancellationError() }
            catch { issue = (error as? UseError)?.code ?? "accessibility_unavailable" }
        }
        try check()
        return WindowState(records: records, visited: visited.count, truncated: issue != nil,
            protectedFrames: protectedFrames, privacyIssue: issue, focused: focused, listCapped: listCapped)
    }
}
