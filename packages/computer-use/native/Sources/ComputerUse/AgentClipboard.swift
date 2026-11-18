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
/// back when a session closes, unless they changed it since. Contents never reach the model.
///
/// A chat can have several apps' sessions open, each in its own helper process, and each
/// helper ends with its session. So what the chat shares lives in private pasteboards named
/// for it: the agent's last copy, the person's kept clipboard, and which clipboard change
/// was the agent's. Every helper then knows whether the clipboard holds the agent's copy,
/// so none keeps the agent's copy as the person's. A close that finds the agent's copy puts
/// the person's back; a later paste in another open session puts the agent's copy back
/// first and keeps the person's again, so the clipboard is the person's whenever no step
/// of the agent's needs it.
final class AgentClipboard {
    static let prefix = "ai.openwork.computer-use.clipboard."
    static let stateType = "ai.openwork.computer-use.clipboard-state"
    /// No copy of the agent's to paste. Nothing was sent and nothing of the person's was touched.
    static let nothingCopied = UseError("nothing_copied", "There is nothing to paste yet: select the content in the app it comes from and copy it with command+c there, then paste here. Nothing was sent.", next: "observe")
    private let general: ClipboardStore
    private let named: (String) -> ClipboardStore
    /// The chat's boards, set by the trusted host's key: its last copy, the person's kept
    /// clipboard, and the shared state. Without a key the helper keeps them itself.
    private var chat: (copy: ClipboardStore, person: ClipboardStore, state: ClipboardStore)?
    private struct Shared: Codable, Equatable {
        /// The system clipboard's change count right after the agent's copy reached it.
        var produced: Int?
        /// The person's clipboard is kept, possibly empty, to put back.
        var saved = false
    }
    private var local = Shared()
    private var localSaved: [[ClipboardEntry]] = []

    init(general: ClipboardStore = NSPasteboard.general,
         named: @escaping (String) -> ClipboardStore = { NSPasteboard(name: NSPasteboard.Name(AgentClipboard.prefix + $0)) }) {
        self.general = general; self.named = named
    }

    /// The chat this helper works for, by the host's random key for it.
    func use(chat key: String) throws {
        guard key.count == 36, key.allSatisfy({ $0.isHexDigit || $0 == "-" }) else {
            throw UseError("invalid_arguments", "clipboard must be the host's key for this chat.")
        }
        let key = key.lowercased()
        chat = (named(key), named(key + ".person"), named(key + ".state"))
    }
    private var shared: Shared {
        get {
            guard let state = chat?.state else { return local }
            let data = state.items().first?.first { $0.type == Self.stateType }?.data
            return data.flatMap { try? JSONDecoder().decode(Shared.self, from: $0) } ?? Shared()
        }
        set {
            guard let state = chat?.state else { local = newValue; return }
            state.replace(with: [[ClipboardEntry(type: Self.stateType, data: (try? JSONEncoder().encode(newValue)) ?? Data())]])
        }
    }
    private func keepPersons(_ items: [[ClipboardEntry]]) {
        if let person = chat?.person { person.replace(with: items) } else { localSaved = items }
        shared.saved = true
    }
    /// The system clipboard's change count right after the agent's copy reached it.
    var produced: Int? { shared.produced }
    var holdsAgentCopy: Bool { produced.map { general.changeCount == $0 } == true }
    /// Whether a paste has anything of the agent's to use.
    var canPaste: Bool { holdsAgentCopy || chat.map { !$0.copy.items().isEmpty } == true }

    /// Before a copy or cut: keep the person's clipboard, as it is now, to put back later.
    func willCopy() -> Int {
        if !holdsAgentCopy { keepPersons(general.items()) }
        return general.changeCount
    }
    /// After the shortcut: whether the app put something on the clipboard. It becomes the chat's copy.
    func didCopy(since before: Int) -> Bool {
        let count = general.changeCount
        guard count != before else { return false }
        shared.produced = count
        chat?.copy.replace(with: general.items())
        return true
    }
    /// Right before a paste: the clipboard holds the agent's copy, put back from the chat's
    /// store (keeping the person's clipboard first) when it holds something else.
    func preparePaste() throws {
        if holdsAgentCopy { return }
        guard let copy = chat?.copy.items(), !copy.isEmpty else {
            throw Self.nothingCopied
        }
        keepPersons(general.items())
        shared.produced = general.replace(with: copy)
    }
    /// A session closed: the person's clipboard comes back, unless they changed it since.
    func restore() {
        let state = shared
        if state.saved, let produced = state.produced, general.changeCount == produced {
            general.replace(with: chat?.person.items() ?? localSaved)
        }
        // Theirs either way now: nothing of the person's is kept any longer.
        shared = Shared(); localSaved = []
        if let person = chat?.person, state.saved { person.replace(with: []) }
    }
}
