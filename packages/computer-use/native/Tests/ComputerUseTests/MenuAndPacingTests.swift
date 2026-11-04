import XCTest
import AppKit
import ApplicationServices
@testable import ComputerUse

final class MenuAndPacingTests: XCTestCase {
    func testMenuShortcutsReadAsDiscoverChords() {
        let bold = MenuRules.shortcut(char: "B", modifiers: 0)!
        XCTAssertEqual(NativeKey.chord(bold.key, bold.flags), "command+b")
        let style = MenuRules.shortcut(char: "v", modifiers: 3)!
        XCTAssertEqual(NativeKey.chord(style.key, style.flags), "command+option+shift+v")
        let controlOnly = MenuRules.shortcut(char: "e", modifiers: 12)!
        XCTAssertEqual(NativeKey.chord(controlOnly.key, controlOnly.flags), "control+e")
        XCTAssertNil(MenuRules.shortcut(char: "e", modifiers: 8), "a bare key is no chord the agent could send")
        XCTAssertNil(MenuRules.shortcut(char: nil, modifiers: 0))
        XCTAssertNil(MenuRules.shortcut(char: "\u{F704}", modifiers: 0))
    }

    func testMenusAreNoWayAroundTheKeyboardRules() {
        func blocked(_ title: String, _ char: String?, _ modifiers: Int = 0) -> Bool {
            MenuRules.blocked(title: title, shortcut: MenuRules.shortcut(char: char, modifiers: modifiers))
        }
        // By shortcut, whatever the app calls the command.
        XCTAssertTrue(blocked("Beenden", "q"))
        XCTAssertTrue(blocked("Fermer la fenêtre", "w"))
        XCTAssertTrue(blocked("Close All", "w", 2))
        XCTAssertTrue(blocked("Paste and Match Style", "v", 3))
        XCTAssertTrue(blocked("Hide Others", "h", 2))
        XCTAssertTrue(blocked("Enter Full Screen", "f", 4))
        // By title when there is no shortcut.
        XCTAssertTrue(blocked("Close Tab", nil))
        XCTAssertTrue(blocked("Services", nil))
        // Ordinary commands stay offered.
        XCTAssertFalse(blocked("Bold", "b"))
        XCTAssertFalse(blocked("Find…", "f"))
        XCTAssertFalse(blocked("Make Plain Text", "t", 1))
        XCTAssertFalse(blocked("Show Ruler", nil))
        XCTAssertTrue(MenuRules.blockedMenus.contains("Window"))
        XCTAssertFalse(MenuRules.offersTopLevelMenu("Window"))
        XCTAssertFalse(MenuRules.offersTopLevelMenu(""))
        XCTAssertTrue(MenuRules.offersTopLevelMenu("File"))
        XCTAssertTrue(MenuRules.offersTopLevelMenu("Format"))
        XCTAssertEqual(MenuRules.leadingMenus, 2, "the Apple and app menus are never offered")
    }

    func testDesignAppsCanOpenHiddenMenusAndFlyouts() throws {
        guard case .rightClick(let point) = try Action(["type": "right_click", "x": 4, "y": 5], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(point, CGPoint(x: 4, y: 5))
        guard case .hold(_, let ms) = try Action(["type": "click", "x": 4, "y": 5, "hold_ms": 800], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(ms, 800)
        guard case .showMenu("e3") = try Action(["type": "show_menu", "ref": "e3"], policy: .embedded) else { return XCTFail() }
        guard case .click(_, 1, let flags) = try Action(["type": "click", "x": 1, "y": 1, "modifiers": ["control"]], policy: .embedded) else { return XCTFail() }
        XCTAssertTrue(flags.contains(.maskControl), "control-click opens a context menu")
        XCTAssertThrowsError(try Action(["type": "click", "x": 1, "y": 1, "modifiers": ["control"]]), "the standalone helper still refuses it")
        XCTAssertThrowsError(try Action(["type": "double_click", "x": 1, "y": 1, "hold_ms": 800], policy: .embedded), "only a single click holds")
        XCTAssertThrowsError(try Action(["type": "click", "x": 1, "y": 1, "hold_ms": 5_000], policy: .embedded), "held at most two seconds")
        XCTAssertTrue(Action.rightClick(.zero).usesCoordinates)
        XCTAssertTrue(InputDelivery.stepNeedsFront(.hold(.zero, 800), route: .appKit), "pointer-following steps take the front")
        XCTAssertFalse(InputDelivery.stepNeedsFront(.showMenu("e1"), route: .appKit), "an accessible menu needs no front")
    }

    func testSingleLettersPickToolsOnlyInCreativeApps() throws {
        guard case .key("u", let flags) = try Action(["type": "key", "key": "u", "modifiers": ["shift"]], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(flags, .maskShift)
        XCTAssertThrowsError(try Action(["type": "key", "key": "u", "modifiers": ["command"]], policy: .embedded), "Command shortcuts keep their own list")
        XCTAssertThrowsError(try Action(["type": "key", "key": "u"]), "the standalone helper still refuses bare letters")
        XCTAssertTrue(NativeKey.isToolKey("b", []))
        XCTAssertFalse(NativeKey.isToolKey("enter", []))
        XCTAssertFalse(NativeKey.isToolKey("b", .maskAlternate))
        XCTAssertTrue(InputDelivery.takesToolKeys(info: ["LSApplicationCategoryType": "public.app-category.graphics-design"]))
        XCTAssertTrue(InputDelivery.takesToolKeys(info: ["LSApplicationCategoryType": "public.app-category.Photography"]))
        XCTAssertFalse(InputDelivery.takesToolKeys(info: ["LSApplicationCategoryType": "public.app-category.productivity"]), "a letter can act in a mail or notes app")
        XCTAssertFalse(InputDelivery.takesToolKeys(info: [:]))
    }

    func testAShortcutWithNothingToTypeIntoRunsItsMenuCommand() throws {
        let entries = [MenuEntry(path: ["File", "Save"], shortcut: "command+s"), MenuEntry(path: ["Edit", "Fill…"], shortcut: "shift+f5")]
        let save = try Action(["type": "key", "key": "s", "modifiers": ["command"]], policy: .embedded)
        XCTAssertEqual(InputDelivery.menuForShortcut(save, in: entries), ["File", "Save"])
        XCTAssertNil(InputDelivery.menuForShortcut(.key("z", .maskCommand), in: entries), "no menu command, no fallback")
        XCTAssertNil(InputDelivery.menuForShortcut(try Action(["type": "key", "key": "enter"], policy: .embedded), in: entries), "only Command shortcuts")
    }

    func testASetValueThatDidNotTakeIsReported() {
        XCTAssertTrue(ValueReadBack.took("72", before: "12" as CFString, after: "72" as CFString))
        XCTAssertTrue(ValueReadBack.took("72", before: "12" as CFString, after: "72 pt" as CFString), "a reformatted value still changed")
        XCTAssertFalse(ValueReadBack.took("5", before: NSNumber(value: 3), after: NSNumber(value: 3)), "the brush kept its old size")
        XCTAssertTrue(ValueReadBack.took("5", before: NSNumber(value: 3), after: NSNumber(value: 5)))
        XCTAssertFalse(ValueReadBack.took("Blue", before: "Red" as CFString, after: "Red" as CFString))
        XCTAssertTrue(ValueReadBack.took("Blue", before: nil, after: "Red" as CFString), "nothing to compare, so no claim")
    }

    func testStrokesInARowStopWhenAWindowOpens() {
        let before = WindowChanges(windows: [1], panels: [], frontmost: true)
        XCTAssertFalse(WindowChanges(windows: [1], panels: [], frontmost: true).opened(since: before))
        XCTAssertTrue(WindowChanges(windows: [1, 2], panels: [], frontmost: true).opened(since: before))
        XCTAssertTrue(WindowChanges(windows: [1], panels: [9], frontmost: true).opened(since: before))
        XCTAssertTrue(Action.isStroke(.drag([.zero, CGPoint(x: 1, y: 1)])))
        XCTAssertFalse(Action.isStroke(.click(.zero, 1, [])))
    }

    func testOpenFileNamesTheRealFileItWillHandOver() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let photo = folder.appendingPathComponent("photo.png")
        try Data([1, 2, 3]).write(to: photo)
        let link = folder.appendingPathComponent("shortcut.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: photo)
        let real = photo.resolvingSymlinksInPath().path

        guard case .openFile(let opened) = try Action(["type": "open_file", "path": photo.path], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(opened.path, real)
        guard case .openFile(let followed) = try Action(["type": "open_file", "path": link.path], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(followed.path, real, "the person approves the file a link points to, not the link")
        XCTAssertTrue(try Action(["type": "open_file", "path": photo.path], policy: .embedded).requiresControl)

        for (path, code) in [("photo.png", "invalid_arguments"), (folder.path, "file_unavailable"), (folder.appendingPathComponent("missing.png").path, "file_unavailable")] {
            XCTAssertThrowsError(try Action(["type": "open_file", "path": path], policy: .embedded), path) { error in
                XCTAssertEqual((error as? UseError)?.code, code, path)
            }
        }
        XCTAssertThrowsError(try Action(["type": "open_file", "path": photo.path], policy: .desktop), "only the OpenWork host offers it")
    }

    func testSaveAsNamesTheRealDestinationAndRefusesFolders() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("exports"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let real = folder.resolvingSymlinksInPath()
        let linkedFolder = folder.appendingPathComponent("linked")
        try FileManager.default.createSymbolicLink(at: linkedFolder, withDestinationURL: folder.appendingPathComponent("exports"))
        let existing = folder.appendingPathComponent("exports/old.pdf")
        try Data([1]).write(to: existing)
        let linkedFile = folder.appendingPathComponent("shortcut.pdf")
        try FileManager.default.createSymbolicLink(at: linkedFile, withDestinationURL: existing)

        guard case .saveAs(let file, let replace) = try Action(["type": "save_as", "path": folder.appendingPathComponent("report.pdf").path], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(file.path, real.appendingPathComponent("report.pdf").path, "a new file in an existing folder")
        XCTAssertFalse(replace, "replacing is off unless the step says so")
        guard case .saveAs(let viaLink, _) = try Action(["type": "save_as", "path": linkedFolder.appendingPathComponent("report.pdf").path], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(viaLink.path, real.appendingPathComponent("exports/report.pdf").path, "the person approves the folder a link points to")
        guard case .saveAs(let overLink, true) = try Action(["type": "save_as", "path": linkedFile.path, "replace": true], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(overLink.path, real.appendingPathComponent("exports/old.pdf").path, "saving over a link writes the file it points to")
        XCTAssertTrue(try Action(["type": "save_as", "path": existing.path], policy: .embedded).requiresControl)

        for (path, code) in [("report.pdf", "invalid_arguments"), (folder.path + "/", "invalid_arguments"), (folder.appendingPathComponent("exports").path, "invalid_arguments"),
                             (folder.appendingPathComponent("missing/report.pdf").path, "folder_unavailable")] {
            XCTAssertThrowsError(try Action(["type": "save_as", "path": path], policy: .embedded), path) { error in
                XCTAssertEqual((error as? UseError)?.code, code, path)
            }
        }
        XCTAssertThrowsError(try Action(["type": "save_as", "path": existing.path, "replace": "yes"], policy: .embedded))
        XCTAssertThrowsError(try Action(["type": "save_as", "path": existing.path, "replace": 1], policy: .embedded), "replace is a boolean, not a number")
        XCTAssertThrowsError(try Action(["type": "save_as", "path": existing.path], policy: .desktop), "only the OpenWork host offers it")
    }

    func testSaveNeverReplacesAFileUnlessTheStepSaysSo() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let existing = folder.appendingPathComponent("report.pdf")
        try Data([1]).write(to: existing)

        XCTAssertThrowsError(try FileHandoff.refuseReplacing(existing, replace: false)) { error in
            XCTAssertEqual((error as? UseError)?.code, "file_exists")
            XCTAssertEqual((error as? UseError)?.payload["next"] as? String, "correct_request")
        }
        XCTAssertNoThrow(try FileHandoff.refuseReplacing(existing, replace: true))
        XCTAssertNoThrow(try FileHandoff.refuseReplacing(folder.appendingPathComponent("new.pdf"), replace: false))

        // The sheet's own "Replace?" prompt is answered the same way: Cancel unless replace is true.
        XCTAssertEqual(SaveRules.replaceAnswer(buttons: ["Cancel", "Replace"], replace: false), "Cancel")
        XCTAssertEqual(SaveRules.replaceAnswer(buttons: ["Cancel", "Replace"], replace: true), "Replace")
        XCTAssertNil(SaveRules.replaceAnswer(buttons: ["Don't Save", "Cancel", "Save"], replace: true), "not a replace prompt")
        XCTAssertNil(SaveRules.replaceAnswer(buttons: ["Replace"], replace: true), "a prompt without a way out is not answered")
    }

    func testASaveCountsOnlyOnceTheFileIsOnDiskAndWrittenAfterSave() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("report.pdf")
        let since = Date()

        XCTAssertNil(FileHandoff.saved(file, before: nil, since: since), "nothing on disk yet")
        try Data(repeating: 7, count: 42).write(to: file)
        XCTAssertEqual(FileHandoff.saved(file, before: nil, since: since)?.bytes, 42, "a new file, with its size")

        // An older file left untouched by the step is not a save.
        let old = Date(timeIntervalSinceNow: -3_600)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: file.path)
        XCTAssertNil(FileHandoff.saved(file, before: nil, since: since), "modified before Save")
        let before = FileHandoff.stamp(file)
        try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        XCTAssertNil(FileHandoff.saved(file, before: FileHandoff.stamp(file), since: since), "unchanged since the step began")
        try Data(repeating: 1, count: 9).write(to: file)
        XCTAssertEqual(FileHandoff.saved(file, before: before, since: since)?.bytes, 9, "a replaced file counts once it is rewritten")
    }

    func testMenuTitlesMatchAsAPersonReadsThem() {
        XCTAssertTrue(MenuRules.same("\u{200E}Bold", "bold"))
        XCTAssertTrue(MenuRules.same("Find…", " Find… "))
        XCTAssertFalse(MenuRules.same("Bold", "Bolder"))
        XCTAssertEqual(MenuEntry(path: ["Format", "Font", "Bold"], shortcut: "command+b").display, "Format › Font › Bold (command+b)")
        XCTAssertEqual(AgentCursor.glyphs("command+shift+b"), "⇧⌘B")
        XCTAssertEqual(AgentCursor.goalLabel("  Draw a wave\n"), "Draw a wave")
        XCTAssertEqual(AgentCursor.goalLabel(String(repeating: "a", count: 60))?.count, 48, "long goals end with an ellipsis")
        XCTAssertNil(AgentCursor.goalLabel(" "))
    }

    func testMenuActionsNeedAMenuAndACommand() throws {
        guard case .menu(let path) = try Action(["type": "menu", "path": ["Format", "Font", "Bold"]], policy: .embedded) else { return XCTFail() }
        XCTAssertEqual(path, ["Format", "Font", "Bold"])
        let menu = try Action(["type": "menu", "path": ["Format", "Bold"]], policy: .embedded)
        XCTAssertFalse(menu.requiresControl, "menu commands work in assist mode")
        XCTAssertFalse(menu.usesCoordinates)
        for bad: [String: Any] in [["type": "menu", "path": ["Format"]], ["type": "menu", "path": ["A", "B", "C", "D", "E"]],
                                   ["type": "menu", "path": ["Format", " "]], ["type": "menu", "path": "Format › Bold"],
                                   ["type": "menu", "path": ["Format", "Bold"], "ref": "e1"]] {
            XCTAssertThrowsError(try Action(bad, policy: .embedded))
        }
        XCTAssertThrowsError(try Action(["type": "menu", "path": ["Format", "Bold"]], policy: .desktop))
    }

    func testRecentDocumentsCannotBypassFileApprovalWithAMenuPath() throws {
        for title in ["Open Recent", "open recent", " Open Recent ", "\u{200E}Open Recent", "Recent Files", "Recent Documents",
                      "Benutzte Dokumente", "Ouvrir l’élément récent", "Ouvrir un élément récent", "Abrir recientes", "最近使った項目を開く",
                      "打开最近使用", "최근 사용 열기", "Открытие недавних", "פתיחת האחרונים", "فتح العناصر الأخيرة",
                      "E\u{301}le\u{301}ments re\u{301}cents"] {
            XCTAssertTrue(MenuRules.blocked(title: title, shortcut: nil), "recent-document submenus must not be listed")
            XCTAssertFalse(MenuRules.offersTopLevelMenu(title), "recent documents must not be listed as a top-level menu either")
            for path in [["File", title], ["File", title, "Private Example.txt"], ["File", "History", title, "Private Example.txt"]] {
                XCTAssertThrowsError(try Action(["type": "menu", "path": path], policy: .embedded)) { error in
                    XCTAssertEqual((error as? UseError)?.code, "blocked_menu_item")
                }
                // The live resolver applies this check too, even for an action
                // constructed directly rather than parsed from tool arguments.
                XCTAssertThrowsError(try MenuRules.validatePath(path))
            }
        }
        XCTAssertNoThrow(try Action(["type": "menu", "path": ["File", "New"]], policy: .embedded))
        XCTAssertNoThrow(try Action(["type": "menu", "path": ["Format", "Font", "Bold"]], policy: .embedded))
    }

    func testEveryAppKitRecentMenuTranslationIsBlocked() throws {
        guard #available(macOS 15.4, *) else { throw XCTSkip("Enumerating AppKit translations needs macOS 15.4") }
        let appKit = Bundle(for: NSDocumentController.self)
        for language in appKit.localizations {
            for (table, key) in [("MenuCommands", "Open Recent"), ("Menus", "Recent Items")] {
                let title = appKit.localizedString(forKey: key, value: key, table: table,
                    localizations: [Locale.Language(identifier: language)])
                XCTAssertTrue(MenuRules.blocked(title: title, shortcut: nil), "\(language): \(title) must be omitted from catalogs")
                XCTAssertFalse(MenuRules.offersTopLevelMenu(title), "\(language): \(title) must not be listed at the top level")
                XCTAssertThrowsError(try Action(["type": "menu", "path": ["File", title, "Private Example.txt"]], policy: .embedded)) { error in
                    XCTAssertEqual((error as? UseError)?.code, "blocked_menu_item")
                }
            }
        }
    }

    func testPacingDefaultsToFastAndBoundsItsRetry() throws {
        XCTAssertEqual(try BatchPacing([:]), .fast)
        XCTAssertEqual(try BatchPacing(["pacing": "wait"]).mode, .wait)
        let retry = try BatchPacing(["pacing": "wait_retry"])
        XCTAssertEqual(retry.mode, .waitRetry); XCTAssertEqual(retry.retry, 1.5)
        XCTAssertEqual(try BatchPacing(["pacing": "wait_retry", "retry_ms": 800]).retry, 0.8)
        XCTAssertThrowsError(try BatchPacing(["pacing": "slow"]))
        XCTAssertThrowsError(try BatchPacing(["pacing": "wait_retry", "retry_ms": 9_000]))
        XCTAssertThrowsError(try BatchPacing(["pacing": "wait", "retry_ms": 500]), "retry_ms only means something with wait_retry")
    }

    func testRetryAcceptsAMovedControlButNeverAChangedOne() {
        let element = AXUIElementCreateApplication(getpid())
        func button(_ label: String, y: CGFloat = 10, enabled: Bool = true) -> ElementRecord {
            var record = ElementRecord(ref: "e1", element: element, role: "AXButton", label: label, value: nil, frame: CGRect(x: 10, y: y, width: 48, height: 48),
                actions: [kAXPressAction], settable: false, enabled: enabled, protected: false)
            record.labelHash = Data(label.utf8)
            return record
        }
        let observed = button("Next")
        XCTAssertFalse(ElementRecord.sameControl(button("Next", y: 80), observed))
        XCTAssertTrue(ElementRecord.sameControl(button("Next", y: 80), observed, allowMove: true))
        XCTAssertFalse(ElementRecord.sameControl(button("Next", y: 80, enabled: false), observed, allowMove: true), "a disabled control is waited for, not pressed")
        XCTAssertFalse(ElementRecord.sameControl(button("Finish", y: 80), observed, allowMove: true))
    }
}
