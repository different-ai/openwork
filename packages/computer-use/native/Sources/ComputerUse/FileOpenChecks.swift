import AppKit
import ApplicationServices
import UniformTypeIdentifiers

/// Whether an app really took a file it was handed: its document window shows, never an
/// alert about it. An app's "could not be opened" alert is a new window too.
enum FileOpenCheck {
    /// An alert, dialog or sheet, not a document window. A file browser or a text field
    /// (an Open panel, a password prompt) is the app asking for more, not refusing.
    static func isAlert(role: String?, subrole: String?, childRoles: Set<String>) -> Bool {
        guard role == "AXSheet" || subrole.map(DialogRules.dialogSubroles.contains) == true else { return false }
        return childRoles.isDisjoint(with: ["AXBrowser", "AXOutline", "AXTable", "AXTextField", "AXSecureTextField", "AXTextArea"])
    }

    /// The step path: a document window that opened proves it, an alert with none refutes it.
    static func outcome(alert: [String: Any]?, documentWindowOpened: Bool, retitled: Bool) -> String {
        if documentWindowOpened { return "file_opened" }
        if alert != nil { return "file_open_failed" }
        return retitled ? "file_opened" : "file_open_unconfirmed"
    }

    /// What the alert says, bounded and marked as the app's own untrusted text.
    static func alert(title: String?, texts: [String]) -> [String: Any] {
        let clean = { (text: String) in String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500)) }
        let heading = title.map(clean).flatMap { $0.isEmpty ? nil : $0 }
        var seen: Set<String> = heading.map { [$0] } ?? []
        let lines = texts.map(clean).filter { !$0.isEmpty && seen.insert($0).inserted }.prefix(4)
        var alert: [String: Any] = ["text": Array(lines), "content_trust": "untrusted_app_content"]
        if let heading { alert["title"] = heading }
        return alert
    }
}

/// Whether an app says it opens a file's type, read from its Info.plist before handing it over.
enum FileTypeCheck: Equatable {
    case fits
    /// The app lists the extension under its own type, not the one this Mac gives the file.
    case note(String)
    /// The app declares neither the type nor the extension: nothing is sent.
    case unsupported(String)

    static func of(_ file: URL, app: String, info: [String: Any]) -> FileTypeCheck {
        let type = (try? file.resourceValues(forKeys: [.contentTypeKey]))?.contentType?.identifier
        return verdict(fileType: type, ext: file.pathExtension, app: app, info: info)
    }

    static func verdict(fileType: String?, ext: String, app: String, info: [String: Any],
                        conforms: (String, String) -> Bool = systemConforms, extensions: (String) -> [String] = systemExtensions) -> FileTypeCheck {
        let documents = info["CFBundleDocumentTypes"] as? [[String: Any]] ?? []
        // An app that declares no documents may still take one: let it try.
        guard !documents.isEmpty else { return .fits }
        let types = documents.flatMap { $0["LSItemContentTypes"] as? [String] ?? [] }
        if let fileType, types.contains(where: { conforms(fileType, $0) }) { return .fits }
        let listed = documents.flatMap { $0["CFBundleTypeExtensions"] as? [String] ?? [] }.map { $0.lowercased() }
        if listed.contains("*") { return .fits }
        var tagged: [String: [String]] = [:]
        for key in ["UTImportedTypeDeclarations", "UTExportedTypeDeclarations"] {
            for declaration in info[key] as? [[String: Any]] ?? [] {
                guard let id = declaration["UTTypeIdentifier"] as? String,
                      let tags = declaration["UTTypeTagSpecification"] as? [String: Any] else { continue }
                let raw = tags["public.filename-extension"]
                tagged[id, default: []] += ((raw as? [String]) ?? (raw as? String).map { [$0] } ?? []).map { $0.lowercased() }
            }
        }
        let wanted = ext.lowercased()
        let given = fileType ?? "an unknown type"
        if !wanted.isEmpty, let declared = types.first(where: { (tagged[$0] ?? extensions($0)).contains(wanted) }) {
            return .note("\(app) declares .\(wanted) as \(declared); this Mac types the file as \(given). If it is refused, use the app's File › Open or Import.")
        }
        if !wanted.isEmpty, listed.contains(wanted) {
            return .note("\(app) lists .\(wanted) files; this Mac types the file as \(given). If it is refused, use the app's File › Open or Import.")
        }
        var opens: [String] = []
        for name in types.flatMap({ tagged[$0] ?? extensions($0) }) + listed where !opens.contains(name) { opens.append(name) }
        let shown = opens.isEmpty ? types.prefix(8).joined(separator: ", ") : opens.prefix(12).map { ".\($0)" }.joined(separator: ", ")
        return .unsupported("\(app) does not declare \(wanted.isEmpty ? given : ".\(wanted) files or \(given)"). It opens \(shown). Convert the file to one of those, or use the app's own Import. Nothing was opened.")
    }

    static func systemConforms(_ type: String, _ declared: String) -> Bool {
        guard let type = UTType(type), let declared = UTType(declared) else { return type == declared }
        return type.conforms(to: declared)
    }
    static func systemExtensions(_ type: String) -> [String] {
        UTType(type)?.tags[.filenameExtension]?.map { $0.lowercased() } ?? []
    }
}

/// Which observed elements an observation lists.
enum ElementFilter {
    /// interactive lists controls; in an alert or dialog it also lists the static text, so
    /// the agent reads why it appeared rather than only its OK button.
    static func shown(_ visible: [ElementRecord], filter: String, dialog: DialogTarget.Kind?) -> [ElementRecord] {
        switch filter {
        case "none": return []
        case "all": return visible
        default:
            let readsText = dialog == .dialog || dialog == .sheet
            return visible.filter { $0.interactive || readsText && $0.role == "AXStaticText" }
        }
    }
}

extension MacAccessibility {
    /// The alert, dialog or sheet the app now shows in front, with its text: nil for a
    /// document window or a panel that asks for more (an Open panel, a password).
    func frontAlert(_ app: AppIdentity) -> [String: Any]? {
        guard let focused = elementAttribute(AXUIElementCreateApplication(app.pid), kAXFocusedWindowAttribute) else { return nil }
        let sheet = (attribute(focused, kAXChildrenAttribute) as? [AXUIElement] ?? [])
            .first { (attribute($0, kAXRoleAttribute) as? String) == "AXSheet" }
        let candidate = sheet ?? focused
        var roles: Set<String> = []
        var texts: [String] = []
        var pending: [(AXUIElement, Int)] = [(candidate, 0)]
        var visited = 0
        while let (element, depth) = pending.popLast(), visited < 200 {
            visited += 1
            let role = attribute(element, kAXRoleAttribute) as? String ?? ""
            if depth > 0 { roles.insert(role) }
            if role == "AXStaticText", let text = attribute(element, kAXValueAttribute) as? String { texts.append(text) }
            guard depth < 6, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            pending += children.reversed().map { ($0, depth + 1) }
        }
        guard FileOpenCheck.isAlert(role: attribute(candidate, kAXRoleAttribute) as? String,
                                    subrole: attribute(candidate, kAXSubroleAttribute) as? String, childRoles: roles) else { return nil }
        return FileOpenCheck.alert(title: attribute(candidate, kAXTitleAttribute) as? String, texts: texts)
    }
}
