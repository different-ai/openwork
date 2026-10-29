import AppKit
import ApplicationServices
import ScreenCaptureKit

/// A dialog an action opened over the session's window: a sheet on it, a dialog
/// window the app moved its focus to, or the system Open/Save panel shown over
/// it for a sandboxed app. The session works in it until it closes, then
/// returns to its window.
struct DialogTarget {
    enum Kind: String { case sheet, dialog, filePanel = "file_panel", window, menu }
    let target: WindowTarget
    let app: AppIdentity
    let kind: Kind
}

extension AppIdentity {
    /// macOS draws Open and Save panels for sandboxed apps in this process.
    static let filePanelService = "com.apple.appkit.xpc.openAndSavePanelService"

    private typealias ResponsiblePID = @convention(c) (pid_t) -> pid_t
    private static let responsiblePID: ResponsiblePID? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")
        .map { unsafeBitCast($0, to: ResponsiblePID.self) }
    /// The app macOS holds responsible for `pid`: for the panel process, the app it serves.
    /// Nil when macOS offers no answer, so a panel is never matched by position alone.
    static func responsible(for pid: pid_t) -> pid_t? {
        guard let responsiblePID else { return nil }
        let owner = responsiblePID(pid)
        return owner > 0 ? owner : nil
    }

    /// The panel process is not a regular app, so `resolve` never returns it.
    /// It is reachable only as a dialog over a window a session already controls.
    static func filePanel(pid: pid_t) -> AppIdentity? {
        guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == filePanelService,
              let executable = app.executableURL, let launched = ProcessStart(pid: pid) else { return nil }
        return AppIdentity(app: app, bundleID: filePanelService, executable: executable, launched: launched)
    }
}

/// macOS prompts only the person may answer: they are drawn by system processes,
/// so a session never sees them, and an agent must never click them.
enum HandoverRules {
    static let prompts: [String: String] = [
        "com.apple.UserNotificationCenter": "permission",
        "com.apple.SecurityAgent": "sign_in",
        "com.apple.CoreAuthUI": "sign_in",
        "com.apple.LocalAuthentication.UIAgent": "sign_in",
        "com.apple.AuthKitUI.AKAuthorizationRemoteViewService": "sign_in",
        "com.apple.AuthenticationServicesCore.AuthenticationServicesAgent": "sign_in",
        "com.apple.PassbookUIService": "payment",
        "com.apple.PassKit.PaymentAuthorizationUIExtension": "payment",
    ]
    static func reason(bundleID: String?) -> String? { bundleID.flatMap { prompts[$0] } }
    static func message(_ reason: String) -> String {
        switch reason {
        case "permission": return "macOS is asking the person to allow something. Only they can answer it; ask them to, then observe again. Nothing was sent."
        case "payment": return "A payment sheet is open. Only the person can confirm a payment; ask them to, then observe again. Nothing was sent."
        default: return "macOS is asking the person to sign in or confirm it's them. Ask them to finish it, then observe again. Nothing was sent."
        }
    }

    /// Follow a new window only when the agent's own last action opened it and the app focused it.
    static func followsNewWindow(focused: CGWindowID?, target: CGWindowID, opened: Set<CGWindowID>) -> Bool {
        guard let focused, focused != target else { return false }
        return opened.contains(focused)
    }
}

enum DialogRules {
    static let dialogSubroles: Set<String> = ["AXDialog", "AXSystemDialog"]
    /// The most files one approval can name; the person sees every one.
    static let maxApprovedFiles = 20
    /// Default buttons that hand the chosen files to the app.
    static let fileConfirmTitles: Set<String> = ["open", "choose", "upload", "select", "attach", "insert", "add", "import", "send"]

    /// A panel for choosing files: the system panel process, or a dialog with a
    /// file browser whose default button hands files over.
    static func isFilePanel(bundleID: String, roles: Set<String>, defaultButton: String?) -> Bool {
        if bundleID == AppIdentity.filePanelService { return true }
        if roles.contains("AXBrowser") { return true }
        guard let title = defaultButton?.lowercased() else { return false }
        return roles.contains("AXOutline") && fileConfirmTitles.contains(title)
    }

    /// Whether this step would hand the panel's selection to the app.
    static func confirmsFilePanel(_ action: Action, pressed: AXUIElement?, defaultButton: AXUIElement?) -> Bool {
        if case .key(let key, _) = action, ["enter", "return"].contains(key) { return true }
        guard let pressed, let defaultButton else { return false }
        return CFEqual(pressed, defaultButton)
    }
}

extension MacAccessibility {
    /// A dialog over `target`, if an action opened one.
    func dialog(over target: WindowTarget, app: AppIdentity) async -> DialogTarget? {
        let root = AXUIElementCreateApplication(app.pid)
        // A sheet is a child of its window.
        if let children = attribute(target.element, kAXChildrenAttribute) as? [AXUIElement],
           let sheet = children.first(where: { (attribute($0, kAXRoleAttribute) as? String) == "AXSheet" }),
           let found = await windowTarget(for: sheet, pid: app.pid) {
            let kind: DialogTarget.Kind = isFilePanel(found, app: app) ? .filePanel : .sheet
            return DialogTarget(target: found, app: app, kind: kind)
        }
        // A dialog window the app moved its focus to.
        if let focused = elementAttribute(root, kAXFocusedWindowAttribute), !CFEqual(focused, target.element),
           let subrole = attribute(focused, kAXSubroleAttribute) as? String, DialogRules.dialogSubroles.contains(subrole),
           let found = await windowTarget(for: focused, pid: app.pid) {
            return DialogTarget(target: found, app: app, kind: isFilePanel(found, app: app) ? .filePanel : .dialog)
        }
        // The system Open/Save panel of a sandboxed app, drawn over the window.
        for service in NSRunningApplication.runningApplications(withBundleIdentifier: AppIdentity.filePanelService) {
            // Only the panel macOS runs for this app; another app's panel over the window is not it.
            guard AppIdentity.responsible(for: service.processIdentifier) == app.pid,
                  let identity = AppIdentity.filePanel(pid: service.processIdentifier) else { continue }
            let windows = attribute(AXUIElementCreateApplication(service.processIdentifier), kAXWindowsAttribute) as? [AXUIElement] ?? []
            for window in windows {
                guard let bounds = frame(window), bounds.intersects(target.frame),
                      target.frame.contains(CGPoint(x: bounds.midX, y: bounds.minY + 1)),
                      let found = await windowTarget(for: window, pid: service.processIdentifier) else { continue }
                return DialogTarget(target: found, app: identity, kind: .filePanel)
            }
        }
        return nil
    }

    /// A window the agent's last action opened, which the app now focuses: a popup
    /// sign-in, a new document or a settings window. Followed like a dialog.
    func openedWindow(by opened: Set<CGWindowID>, over target: WindowTarget, app: AppIdentity) async -> DialogTarget? {
        guard !opened.isEmpty, let focused = elementAttribute(AXUIElementCreateApplication(app.pid), kAXFocusedWindowAttribute),
              let found = await windowTarget(for: focused, pid: app.pid),
              HandoverRules.followsNewWindow(focused: found.id, target: target.id, opened: opened) else { return nil }
        // An app's file picker can be an ordinary window: it keeps the file-panel rules.
        return DialogTarget(target: found, app: app, kind: isFilePanel(found, app: app) ? .filePanel : .window)
    }

    /// A menu the app has open: a pop-up, a context menu or one from its menu bar.
    /// Its items are read and pressed like any element until it closes.
    func openMenu(of app: AppIdentity) async -> DialogTarget? {
        let root = AXUIElementCreateApplication(app.pid)
        var candidates = (attribute(root, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter { (attribute($0, kAXRoleAttribute) as? String) == "AXMenu" }
        if let bar = elementAttribute(root, kAXMenuBarAttribute) {
            for item in attribute(bar, kAXChildrenAttribute) as? [AXUIElement] ?? [] where (attribute(item, kAXSelectedAttribute) as? Bool) == true {
                candidates += (attribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter { (attribute($0, kAXRoleAttribute) as? String) == "AXMenu" }
            }
        }
        for menu in candidates {
            if let found = await windowTarget(for: menu, pid: app.pid) { return DialogTarget(target: found, app: app, kind: .menu) }
        }
        return nil
    }

    /// A prompt only the person may answer, on screen now.
    func personPrompt() -> (reason: String, app: String)? {
        let onScreen = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let owners = Set(onScreen.compactMap { $0[kCGWindowOwnerPID as String] as? Int32 })
        for pid in owners {
            guard let app = NSRunningApplication(processIdentifier: pid), let reason = HandoverRules.reason(bundleID: app.bundleIdentifier) else { continue }
            return (reason, app.localizedName ?? "macOS")
        }
        return nil
    }

    /// Whether a followed dialog is still on screen.
    func dialogOpen(_ dialog: WindowTarget, app: AppIdentity) -> Bool {
        guard (try? app.validate()) != nil, frame(dialog.element) != nil,
              let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, dialog.id) as? [[String: Any]] else { return false }
        return info.contains { ($0[kCGWindowOwnerPID as String] as? Int32) == app.pid && ($0[kCGWindowIsOnscreen as String] as? Bool) == true }
    }

    func defaultButton(_ dialog: WindowTarget) -> AXUIElement? {
        elementAttribute(dialog.element, kAXDefaultButtonAttribute)
    }

    /// The names a file panel would hand over: its selected rows, or the name field of a save panel.
    func selectedFileNames(_ dialog: WindowTarget) -> [String] {
        var names: [String] = []
        var pending: [(AXUIElement, Int)] = [(dialog.element, 0)]
        var visited = 0
        while let (element, depth) = pending.popLast(), visited < 400 {
            visited += 1
            let role = attribute(element, kAXRoleAttribute) as? String
            if ["AXOutline", "AXTable", "AXList", "AXBrowser"].contains(role ?? ""),
               let rows = attribute(element, kAXSelectedRowsAttribute) as? [AXUIElement] {
                names += rows.prefix(DialogRules.maxApprovedFiles + 1).compactMap(rowName)
            }
            if role == "AXTextField", (attribute(element, kAXIdentifierAttribute) as? String)?.lowercased().contains("save") == true,
               let value = attribute(element, kAXValueAttribute) as? String, !value.isEmpty {
                names.append(value)
            }
            guard depth < 12, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            pending += children.map { ($0, depth + 1) }
        }
        // Never merged: two selected files with one name are two files the person must see.
        return Array(names.prefix(DialogRules.maxApprovedFiles + 1))
    }

    private func rowName(_ row: AXUIElement) -> String? {
        var pending = [row]
        var visited = 0
        while let element = pending.popLast(), visited < 40 {
            visited += 1
            for name in [kAXValueAttribute, kAXTitleAttribute] {
                if let text = attribute(element, name) as? String, !text.isEmpty { return String(text.prefix(255)) }
            }
            pending += attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        }
        return nil
    }

    private func isFilePanel(_ dialog: WindowTarget, app: AppIdentity) -> Bool {
        var roles: Set<String> = []
        var pending: [(AXUIElement, Int)] = [(dialog.element, 0)]
        var visited = 0
        while let (element, depth) = pending.popLast(), visited < 300 {
            visited += 1
            if let role = attribute(element, kAXRoleAttribute) as? String { roles.insert(role) }
            guard depth < 8, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            pending += children.map { ($0, depth + 1) }
        }
        let title = defaultButton(dialog).flatMap { attribute($0, kAXTitleAttribute) as? String }
        return DialogRules.isFilePanel(bundleID: app.bundleID, roles: roles, defaultButton: title)
    }

    /// The on-screen window of `element`, matched by frame as `windows` does.
    private func windowTarget(for element: AXUIElement, pid: pid_t) async -> WindowTarget? {
        guard let bounds = frame(element), Geometry.valid(bounds),
              let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return nil }
        let matches = content.windows.filter { window in
            window.owningApplication?.processID == pid && window.frame.width > 20 && window.frame.height > 20
                && abs(bounds.minX - window.frame.minX) < 2 && abs(bounds.minY - window.frame.minY) < 2
                && abs(bounds.width - window.frame.width) < 2 && abs(bounds.height - window.frame.height) < 2
        }
        guard matches.count == 1, let window = matches.first else { return nil }
        AXUIElementSetMessagingTimeout(element, 0.2)
        let title = attribute(element, kAXTitleAttribute) as? String
        return WindowTarget(id: window.windowID, title: title?.isEmpty == false ? title! : "Dialog", element: element, frame: window.frame)
    }
}
