import XCTest
@testable import ComputerUse

/// A clipboard in memory: the tests never read or change the person's real one.
private final class Board: ClipboardStore {
    var changeCount = 0
    var contents: [[ClipboardEntry]] = []
    func items() -> [[ClipboardEntry]] { contents }
    @discardableResult func replace(with items: [[ClipboardEntry]]) -> Int { contents = items; changeCount += 1; return changeCount }
}
private func item(_ text: String) -> [[ClipboardEntry]] {
    [[ClipboardEntry(type: "public.utf8-plain-text", data: Data(text.utf8)), ClipboardEntry(type: "public.rtf", data: Data("{\\rtf1 \(text)}".utf8))]]
}

final class ClipboardTests: XCTestCase {
    private let chat = "0f8f6c1e-6a52-4c0e-9b8e-2f4c8a1d3b70"
    private var general = Board()
    private var stores: [String: Board] = [:]
    private func clipboard(for key: String? = nil) throws -> AgentClipboard {
        let clipboard = AgentClipboard(general: general, named: { name in
            if let board = self.stores[name] { return board }
            let board = Board(); self.stores[name] = board; return board
        })
        if let key { try clipboard.use(chat: key) }
        return clipboard
    }
    /// What an app does on Command-C or Command-X.
    private func appCopies(_ text: String) { general.replace(with: item(text)) }

    func testPasteRefusesThePersonsClipboard() throws {
        general.replace(with: item("the person's bank details"))
        let clipboard = try clipboard(for: chat)
        XCTAssertFalse(clipboard.canPaste)
        XCTAssertThrowsError(try clipboard.preparePaste()) { error in
            let refusal = error as? UseError
            XCTAssertEqual(refusal?.code, "nothing_copied")
            XCTAssertEqual(refusal?.next, "observe")
            XCTAssertTrue(refusal?.message.contains("copy it with command+c there") == true, "the agent learns to copy in the source app first")
            XCTAssertTrue(refusal?.message.hasSuffix("Nothing was sent.") == true)
        }
        XCTAssertEqual(general.contents, item("the person's bank details"), "a refused paste changes nothing")
    }

    func testCopyLendsTheClipboardAndCloseGivesItBack() throws {
        general.replace(with: item("theirs"))
        let clipboard = try clipboard(for: chat)
        let before = clipboard.willCopy()
        appCopies("table")
        XCTAssertTrue(clipboard.didCopy(since: before))
        XCTAssertTrue(clipboard.holdsAgentCopy)
        XCTAssertNoThrow(try clipboard.preparePaste())
        XCTAssertEqual(general.contents, item("table"), "a paste of the agent's own copy leaves it in place")
        clipboard.restore()
        XCTAssertEqual(general.contents, item("theirs"), "every representation comes back in order")
        XCTAssertNil(clipboard.produced)
    }

    func testThePersonsNewerCopyIsKeptAndNeverPasted() throws {
        general.replace(with: item("theirs"))
        let clipboard = try clipboard()
        let before = clipboard.willCopy()
        appCopies("table")
        XCTAssertTrue(clipboard.didCopy(since: before))
        general.replace(with: item("their newer copy"))
        XCTAssertFalse(clipboard.holdsAgentCopy)
        // Without the host's chat key there is nothing of the agent's left to paste.
        XCTAssertThrowsError(try clipboard.preparePaste()) { XCTAssertEqual(($0 as? UseError)?.code, "nothing_copied") }
        clipboard.restore()
        XCTAssertEqual(general.contents, item("their newer copy"), "a clipboard the person changed is never overwritten")
    }

    func testAPasteAfterThePersonCopiedPutsTheAgentsCopyBackFirst() throws {
        general.replace(with: item("theirs"))
        let clipboard = try clipboard(for: chat)
        let before = clipboard.willCopy()
        appCopies("table")
        XCTAssertTrue(clipboard.didCopy(since: before))
        general.replace(with: item("their newer copy"))
        try clipboard.preparePaste()
        XCTAssertEqual(general.contents, item("table"), "only the agent's own copy is pasted")
        clipboard.restore()
        XCTAssertEqual(general.contents, item("their newer copy"))
    }

    func testTheNextAppInTheChatPastesWhatTheLastOneCopied() throws {
        general.replace(with: item("theirs"))
        let numbers = try clipboard(for: chat)
        let before = numbers.willCopy()
        appCopies("table")
        XCTAssertTrue(numbers.didCopy(since: before))
        numbers.restore()  // computer_close ends this helper
        XCTAssertEqual(general.contents, item("theirs"))

        let keynote = try clipboard(for: chat)
        XCTAssertTrue(keynote.canPaste)
        try keynote.preparePaste()
        XCTAssertEqual(general.contents, item("table"))
        keynote.restore()
        XCTAssertEqual(general.contents, item("theirs"))

        let otherChat = try clipboard(for: "7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6")
        XCTAssertFalse(otherChat.canPaste, "another chat never pastes this chat's copy")
    }

    func testACopyThatCopiedNothingChangesNothing() throws {
        general.replace(with: item("theirs"))
        let clipboard = try clipboard(for: chat)
        let before = clipboard.willCopy()
        XCTAssertFalse(clipboard.didCopy(since: before), "nothing was selected")
        XCTAssertFalse(clipboard.canPaste)
        let count = general.changeCount
        clipboard.restore()
        XCTAssertEqual(general.changeCount, count)
        XCTAssertEqual(general.contents, item("theirs"))
    }

    func testOnlyTheHostsKeyNamesAChatsClipboard() throws {
        let clipboard = try clipboard()
        for key in ["", "general", "../../Library", String(repeating: "a", count: 37), "0f8f6c1e-6a52-4c0e-9b8e-2f4c8a1d3b7z"] {
            XCTAssertThrowsError(try clipboard.use(chat: key), key) { XCTAssertEqual(($0 as? UseError)?.code, "invalid_arguments") }
        }
        XCTAssertTrue(stores.isEmpty)
    }

    func testOnlyExactClipboardChordsAreClipboardSteps() throws {
        func step(_ key: String, _ modifiers: [String]) throws -> ClipboardStep? {
            try Action(["type": "key", "key": key, "modifiers": modifiers], policy: .embedded).clipboard
        }
        XCTAssertEqual(try step("c", ["command"]), .copy)
        XCTAssertEqual(try step("x", ["command"]), .cut)
        XCTAssertEqual(try step("v", ["command"]), .paste)
        XCTAssertNil(try step("s", ["command"]))
        XCTAssertNil(try step("a", ["command"]))
        // Menus keep hiding Copy, Cut and Paste, so a paste never runs from a menu path.
        XCTAssertTrue(MenuRules.blocked(title: "Paste", shortcut: nil))
        XCTAssertTrue(MenuRules.blocked(title: "Paste and Match Style", shortcut: ("v", [.maskCommand, .maskAlternate, .maskShift])))
    }

    func testTheOpenedFilesWindowIsFoundOnlyWhenCertain() {
        let file = URL(fileURLWithPath: "/Users/someone/Desktop/Quarterly report.pdf")
        XCTAssertEqual(FileHandoff.window(for: file, in: [(1, "Notes"), (2, "Quarterly report.pdf")], opened: []), 2)
        XCTAssertEqual(FileHandoff.window(for: file, in: [(1, "Notes"), (2, "Quarterly report")], opened: []), 2, "apps that hide the extension")
        XCTAssertEqual(FileHandoff.window(for: file, in: [(1, "Notes"), (3, "Untitled")], opened: [3]), 3, "the one window that opened")
        XCTAssertEqual(FileHandoff.window(for: file, in: [(2, "Quarterly report.pdf"), (4, "Quarterly report.pdf – copy")], opened: [4]), 4)
        XCTAssertNil(FileHandoff.window(for: file, in: [(1, "Notes"), (3, "A"), (4, "B")], opened: [3, 4]))
        XCTAssertNil(FileHandoff.window(for: file, in: [(1, "Notes")], opened: []))
    }

    @MainActor
    func testTheStandaloneHelperTakesNoFileOrClipboardFromAnOpen() async throws {
        let runtime = SessionRuntime()
        for extra in [["file": "/tmp/report.pdf"], ["clipboard": chat], ["file_approval": ["/tmp/report.pdf"]]] as [[String: Any]] {
            let args = ["app_id": "com.apple.TextEdit", "mode": "control", "purpose": "edit"].merging(extra) { $1 }
            do { _ = try await runtime.call("computer_open_session", args); XCTFail("\(extra) was accepted") }
            catch let error as UseError { XCTAssertEqual(error.code, "invalid_arguments") }
        }
    }
}
