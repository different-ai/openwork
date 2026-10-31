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

    func testMenuTitlesMatchAsAPersonReadsThem() {
        XCTAssertTrue(MenuRules.same("\u{200E}Bold", "bold"))
        XCTAssertTrue(MenuRules.same("Find…", " Find… "))
        XCTAssertFalse(MenuRules.same("Bold", "Bolder"))
        XCTAssertEqual(MenuEntry(path: ["Format", "Font", "Bold"], shortcut: "command+b").display, "Format › Font › Bold (command+b)")
        XCTAssertEqual(AgentCursor.glyphs("command+shift+b"), "⇧⌘B")
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
