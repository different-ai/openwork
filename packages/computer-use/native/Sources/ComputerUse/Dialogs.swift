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
    /// How long an observation waits for the person to answer, well inside one call's time limit.
    static let personWait: TimeInterval = 60
    static let personPoll: TimeInterval = 0.5
    static func reason(bundleID: String?) -> String? { bundleID.flatMap { prompts[$0] } }
    /// `waited`: an observation already waited `personWait` and the prompt is still open.
    static func message(_ reason: String, waited: Bool = false) -> String {
        let prompt: String
        switch reason {
        case "permission": prompt = "macOS is asking the person to allow something"
        case "payment": prompt = "A payment sheet is open, and only the person can confirm a payment"
        default: prompt = "macOS is asking the person to sign in or confirm it's them"
        }
        return waited
            ? "\(prompt), still unanswered after a minute. Only they can answer it; ask them to, then observe again. Nothing was sent."
            : "\(prompt). Observe again: it waits up to a minute for them to answer. Nothing was sent."
    }
    /// Waits while a prompt only the person may answer is open. Returns nil once it is
    /// gone, or the prompt still open after `limit`; Take over or Stop ends the wait (`check`).
    @MainActor static func waitForPerson(prompt: () -> (reason: String, app: String)?, check: () throws -> Void,
        now: () -> TimeInterval, sleep: (TimeInterval) async throws -> Void, limit: TimeInterval = personWait) async throws -> (reason: String, app: String)? {
        let started = now()
        while let open = prompt() {
            try check()
            guard now() - started < limit else { return open }
            try await sleep(personPoll)
        }
        try check()
        return nil
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

/// Save and Export sheets: the step that writes a file answers their replace prompt itself.
enum SaveRules {
    /// The button to press when the sheet asks whether to replace a file, or nil when these
    /// buttons are not that prompt. Replacing happens only when the step said so.
    static func replaceAnswer(buttons: [String], replace: Bool) -> String? {
        let titles = buttons.map { $0.trimmingCharacters(in: .whitespaces) }
        guard let yes = titles.first(where: { $0.lowercased() == "replace" }),
              let no = titles.first(where: { $0.lowercased() == "cancel" }) else { return nil }
        return replace ? yes : no
    }
}

extension MacAccessibility {
    /// The name field of a Save or Export sheet ("Save As"), by the identifier AppKit gives it.
    func saveNameField(_ dialog: WindowTarget) -> AXUIElement? {
        firstElement(in: dialog.element) { element in
            (attribute(element, kAXRoleAttribute) as? String) == "AXTextField"
                && (attribute(element, kAXIdentifierAttribute) as? String)?.lowercased().contains("save") == true
        }
    }

    /// The text field that has the keyboard in `pid`: after Command-Shift-G, the panel's Go To field.
    func focusedTextField(_ pid: pid_t) -> AXUIElement? {
        guard let focused = elementAttribute(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute),
              ["AXTextField", "AXComboBox"].contains(attribute(focused, kAXRoleAttribute) as? String ?? "") else { return nil }
        return focused
    }

    /// The buttons of a prompt over a save sheet: a sheet on it, or a dialog the app focused.
    func savePrompt(over dialog: WindowTarget, app: AppIdentity) -> [(title: String, button: AXUIElement)] {
        var prompts = (attribute(dialog.element, kAXChildrenAttribute) as? [AXUIElement] ?? [])
            .filter { (attribute($0, kAXRoleAttribute) as? String) == "AXSheet" }
        if let focused = elementAttribute(AXUIElementCreateApplication(app.pid), kAXFocusedWindowAttribute), !CFEqual(focused, dialog.element),
           DialogRules.dialogSubroles.contains(attribute(focused, kAXSubroleAttribute) as? String ?? "") {
            prompts.append(focused)
        }
        return prompts.flatMap { prompt in
            elements(in: prompt) { (attribute($0, kAXRoleAttribute) as? String) == "AXButton" }
                .compactMap { button in (attribute(button, kAXTitleAttribute) as? String).map { ($0, button) } }
        }
    }

    private func firstElement(in root: AXUIElement, where match: (AXUIElement) -> Bool) -> AXUIElement? {
        elements(in: root, limit: 1, where: match).first
    }
    private func elements(in root: AXUIElement, limit: Int = 40, where match: (AXUIElement) -> Bool) -> [AXUIElement] {
        var found: [AXUIElement] = []
        var pending: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        while let (element, depth) = pending.popLast(), visited < 400, found.count < limit {
            visited += 1
            if match(element) { found.append(element) }
            guard depth < 12, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            pending += children.map { ($0, depth + 1) }
        }
        return found
    }

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
