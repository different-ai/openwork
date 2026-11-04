import AppKit

/// One representation of a clipboard item, as the app that copied it wrote it.
struct ClipboardEntry: Equatable {
    let type: String
    let data: Data
}

/// What the agent's clipboard reads and writes: the system clipboard, or a private one.
protocol ClipboardStore: AnyObject {
    var changeCount: Int { get }
    /// Every item with every representation, in the order the app wrote them.
    func items() -> [[ClipboardEntry]]
    /// Replaces the contents and returns the new change count.
    @discardableResult func replace(with items: [[ClipboardEntry]]) -> Int
}

extension NSPasteboard: ClipboardStore {
    func items() -> [[ClipboardEntry]] {
        (pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { ClipboardEntry(type: type.rawValue, data: $0) } }
        }
    }
    @discardableResult func replace(with items: [[ClipboardEntry]]) -> Int {
        clearContents()
        let objects = items.map { entries -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for entry in entries { item.setData(entry.data, forType: NSPasteboard.PasteboardType(entry.type)) }
            return item
        }
        if !objects.isEmpty { writeObjects(objects) }
        return changeCount
    }
}

/// The agent's own clipboard in a chat. Command-C and Command-X lend the system clipboard
/// to the agent; Command-V runs only while it holds what the agent itself copied, so a
/// paste never carries the person's clipboard into an app. The person's clipboard comes
/// back when the session closes, unless they changed it since. Contents never reach the model.
///
/// A chat's helper ends with each session, so the agent's last copy is also kept in a
/// private pasteboard named for the chat: the next app's session pastes it from there.
final class AgentClipboard {
    static let prefix = "ai.openwork.computer-use.clipboard."
    /// No copy of the agent's to paste. Nothing was sent and nothing of the person's was touched.
    static let nothingCopied = UseError("nothing_copied", "There is nothing to paste yet: select the content in the app it comes from and copy it with command+c there, then paste here. Nothing was sent.", next: "observe")
    private let general: ClipboardStore
    private let named: (String) -> ClipboardStore
    /// The chat's last copy, kept across its helpers. Set by the trusted host only.
    private var store: ClipboardStore?
    /// The system clipboard's change count right after the agent's copy reached it.
    private(set) var produced: Int?
    /// The person's clipboard while the agent holds it.
    private var saved: [[ClipboardEntry]]?

    init(general: ClipboardStore = NSPasteboard.general,
         named: @escaping (String) -> ClipboardStore = { NSPasteboard(name: NSPasteboard.Name(AgentClipboard.prefix + $0)) }) {
        self.general = general; self.named = named
    }

    /// The chat this helper works for, by the host's random key for it.
    func use(chat key: String) throws {
        guard key.count == 36, key.allSatisfy({ $0.isHexDigit || $0 == "-" }) else {
            throw UseError("invalid_arguments", "clipboard must be the host's key for this chat.")
        }
        store = named(key.lowercased())
    }
    var holdsAgentCopy: Bool { produced != nil && general.changeCount == produced }
    /// Whether a paste has anything of the agent's to use.
    var canPaste: Bool { holdsAgentCopy || store.map { !$0.items().isEmpty } == true }

    /// Before a copy or cut: keep the person's clipboard, as it is now, to put back later.
    func willCopy() -> Int {
        if !holdsAgentCopy { saved = general.items() }
        return general.changeCount
    }
    /// After the shortcut: whether the app put something on the clipboard. It becomes the chat's copy.
    func didCopy(since before: Int) -> Bool {
        let count = general.changeCount
        guard count != before else { return false }
        produced = count
        store?.replace(with: general.items())
        return true
    }
    /// Right before a paste: the clipboard holds the agent's copy, put back from the chat's
    /// store (keeping the person's clipboard first) when it holds something else.
    func preparePaste() throws {
        if holdsAgentCopy { return }
        guard let copy = store?.items(), !copy.isEmpty else {
            throw Self.nothingCopied
        }
        saved = general.items()
        produced = general.replace(with: copy)
    }
    /// The session closed: the person's clipboard comes back, unless they changed it since.
    func restore() {
        defer { produced = nil; saved = nil }
        guard holdsAgentCopy, let saved else { return }
        general.replace(with: saved)
    }
}
