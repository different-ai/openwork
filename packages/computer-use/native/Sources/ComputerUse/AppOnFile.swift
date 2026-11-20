import AppKit

/// Opening an app straight onto a file the person approved, in one computer_open.
extension FileHandoff {
    /// Hands the file to the app at `app`, launching it on the document when it is not running.
    @MainActor static func open(_ file: URL, in app: URL, activates: Bool) async throws -> NSRunningApplication {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = activates
        do { return try await NSWorkspace.shared.open([file], withApplicationAt: app, configuration: configuration) }
        catch { throw UseError("open_failed", "The app did not accept the file. Nothing was opened.", next: "open_session") }
    }

    /// The window showing the file: the only one titled with its name, or else the only
    /// window that opened since the file was handed over. Nil when neither is certain.
    static func window(for file: URL, in windows: [(id: Int, title: String)], opened: Set<Int>) -> Int? {
        let names = Set([file.lastPathComponent, file.deletingPathExtension().lastPathComponent].filter { !$0.isEmpty })
        let titled = windows.filter { window in names.contains { window.title.localizedCaseInsensitiveCompare($0) == .orderedSame } }
        if titled.count == 1 { return titled[0].id }
        let new = windows.filter { opened.contains($0.id) }
        if new.count == 1 { return new[0].id }
        let both = titled.filter { opened.contains($0.id) }
        return both.count == 1 ? both[0].id : nil
    }
}
