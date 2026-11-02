import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// One command from the app's menu bar, offered as a quick action.
struct MenuEntry: Equatable {
    let path: [String]
    let shortcut: String?
    var display: String { path.joined(separator: " › ") + (shortcut.map { " (\($0))" } ?? "") }
}

/// A menu command resolved live, ready to press.
struct MenuTarget {
    let item: AXUIElement
    /// The menu-bar title the command lives under, for the on-desktop cursor.
    let titleFrame: CGRect?
    let shortcut: String?
}

/// What the menu bar may offer. Menus are read without opening them and pressed
/// through accessibility. The Apple and app menus (Quit, Hide, Services, Settings),
/// the Window menu and any command whose shortcut is a blocked chord (Close,
/// Minimize, clipboard) are never offered or pressed, so a menu is no way around
/// the keyboard rules.
enum MenuRules {
    /// The Apple menu and the app menu come first in every app's menu bar.
    static let leadingMenus = 2
    static let maxDepth = 3
    static let maxEntries = 250
    static let blockedMenus: Set<String> = ["Window"]
    static let blockedPrefixes = ["Quit", "Close", "Hide", "Minimize", "Services", "Copy", "Cut", "Paste", "Log Out"]
    /// Recent documents need file approval, including when the caller supplies a
    /// path in a different language from this process. Keep AppKit's translated
    /// labels as a fallback for macOS 14, which cannot enumerate translations
    /// through Bundle's public localization API yet.
    static let blockedSubmenus: Set<String> = {
        var titles: Set<String> = [
            "Open Recent", "Recent Files", "Recent Documents", "Recent Items",
            "Abrir Recente", "Abrir documento recente", "Abrir recientes", "Apri recenti",
            "Avaa äskeinen", "Benutzte Dokumente", "Buka Terbaharu", "Buka Terbaru",
            "Deschideți recente", "Legutóbbi megnyitása", "Mở Mục gần đây", "Obre els recents",
            "Odpri nedavno", "Open recente bestanden", "Otvori nedavne stavke", "Otvoriť posledné",
            "Otwórz ostatnie", "Ouvrir l’élément récent", "Ouvrir un élément récent", "Ouvrir élément récent",
            "Poslední položky", "Son Kullanılanı Aç",
            "Åbn seneste", "Åpne sist brukte", "Öppna senaste", "Άνοιγμα πρόσφατου",
            "Останні документи", "Открытие недавних", "פתיחת האחרונים", "فتح العناصر الأخيرة",
            "हालिया खोलें", "เปิดล่าสุด", "打开最近使用", "打開最近使用過的檔案", "最近使った項目を開く",
            "開啟最近項目", "최근 사용 열기",
            "Articole recente", "Benutzte Objekte", "Elementi recenti", "Elementos recentes",
            "Elementos recientes", "Item Terbaharu", "Item Terbaru", "Itens Recentes",
            "Legutóbbi elemek", "Mục gần đây", "Nedavni elementi", "Novije stavke",
            "Ostatnie rzeczy", "Posledné položky", "Recente onderdelen", "Senaste objekt",
            "Seneste emner", "Sist brukte objekter", "Son Kullanılan Öğeler", "Äskeiset kohteet",
            "Éléments récents", "Ítems recents", "Ítems recientes", "Πρόσφατα στοιχεία",
            "Недавние объекты", "Недавні елементи", "פריטים אחרונים", "العناصر الأخيرة",
            "हालिया आइटम", "รายการล่าสุด", "最近使った項目", "最近使用的项目", "最近使用過的項目", "최근 사용 항목",
        ]
        let appKit = Bundle(for: NSDocumentController.self)
        for (table, key) in [("MenuCommands", "Open Recent"), ("Menus", "Recent Items")] {
            titles.insert(appKit.localizedString(forKey: key, value: key, table: table))
            if #available(macOS 15.4, *) {
                for language in appKit.localizations {
                    titles.insert(appKit.localizedString(forKey: key, value: key, table: table,
                        localizations: [Locale.Language(identifier: language)]))
                }
            }
        }
        return Set(titles.map(normalizedTitle))
    }()

    private static func normalizedTitle(_ title: String) -> String {
        ElementRecord.visibleText(title).trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased().precomposedStringWithCanonicalMapping
    }

    static func offersTopLevelMenu(_ title: String) -> Bool {
        !title.isEmpty && !blockedMenus.contains(title) && !blockedSubmenus.contains(normalizedTitle(title))
    }

    static func validatePath(_ path: [String]) throws {
        guard !path.contains(where: { blockedSubmenus.contains(normalizedTitle($0)) }) else {
            throw UseError("blocked_menu_item", "Recent documents require file approval and cannot be opened through a menu path.", next: "observe")
        }
    }

    /// The chord a menu item's key equivalent sends, in computer_discover's names.
    /// AX modifier bits: 1 shift, 2 option, 4 control, 8 means no Command.
    static func shortcut(char: String?, modifiers: Int?) -> (key: String, flags: CGEventFlags)? {
        guard let char = char?.trimmingCharacters(in: .whitespaces).lowercased(), char.count == 1,
              let scalar = char.unicodeScalars.first, scalar.properties.isAlphabetic || CharacterSet.decimalDigits.contains(scalar) || "`,./;'[]-=".unicodeScalars.contains(scalar) else { return nil }
        let bits = modifiers ?? 0
        var flags = CGEventFlags()
        if bits & 8 == 0 { flags.insert(.maskCommand) }
        if bits & 1 != 0 { flags.insert(.maskShift) }
        if bits & 2 != 0 { flags.insert(.maskAlternate) }
        if bits & 4 != 0 { flags.insert(.maskControl) }
        // A bare key (Emoji & Symbols' globe-E) is no chord the agent could send.
        return flags.isEmpty ? nil : (char, flags)
    }

    static func blocked(title: String, shortcut: (key: String, flags: CGEventFlags)?) -> Bool {
        if blockedSubmenus.contains(normalizedTitle(title)) { return true }
        if let shortcut, NativeKey.isBlocked(shortcut.key, shortcut.flags) { return true }
        return blockedPrefixes.contains { title.hasPrefix($0) }
    }

    static func same(_ title: String, _ wanted: String) -> Bool {
        ElementRecord.visibleText(title).trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(wanted.trimmingCharacters(in: .whitespaces)) == .orderedSame
    }
}

extension MacAccessibility {
    private func menuTitle(_ element: AXUIElement) -> String {
        ElementRecord.visibleText((attribute(element, kAXTitleAttribute) as? String) ?? "")
    }
    private func submenu(_ element: AXUIElement) -> AXUIElement? {
        (attribute(element, kAXChildrenAttribute) as? [AXUIElement])?.first { (attribute($0, kAXRoleAttribute) as? String) == "AXMenu" }
    }
    private func menuChildren(_ menu: AXUIElement) -> [AXUIElement] {
        (attribute(menu, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter { (attribute($0, kAXRoleAttribute) as? String) == "AXMenuItem" }
    }
    private func menuShortcut(_ item: AXUIElement) -> (key: String, flags: CGEventFlags)? {
        MenuRules.shortcut(char: attribute(item, kAXMenuItemCmdCharAttribute) as? String,
                           modifiers: (attribute(item, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.intValue)
    }
    private func screenFrame(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
        let frame = CGRect(origin: origin, size: extent)
        return Geometry.valid(frame) ? frame : nil
    }
    /// The menus a command may come from, by title: the app's own menus after
    /// the Apple and app menus, without the blocked ones.
    private func offeredMenus(_ app: AppIdentity) -> [(title: String, item: AXUIElement)] {
        guard let bar = elementAttribute(AXUIElementCreateApplication(app.pid), kAXMenuBarAttribute) else { return [] }
        let items = attribute(bar, kAXChildrenAttribute) as? [AXUIElement] ?? []
        return items.dropFirst(MenuRules.leadingMenus).compactMap { item in
            let title = menuTitle(item)
            return MenuRules.offersTopLevelMenu(title) ? (title, item) : nil
        }
    }

    /// One item's menu attributes in a single accessibility call instead of five.
    private func menuItemFacts(_ item: AXUIElement) -> (title: String, enabled: Bool, shortcut: (key: String, flags: CGEventFlags)?, submenu: AXUIElement?)? {
        let names = [kAXRoleAttribute, kAXTitleAttribute, kAXEnabledAttribute, kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute, kAXChildrenAttribute] as CFArray
        var raw: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(item, names, [], &raw) == .success, let values = raw as? [AnyObject], values.count == 6 else { return nil }
        // A missing attribute comes back as an AXValue error; casts below read it as absent.
        guard (values[0] as? String) == "AXMenuItem" else { return nil }
        let children = values[5] as? [AXUIElement] ?? []
        let child = children.first { (attribute($0, kAXRoleAttribute) as? String) == "AXMenu" }
        return (ElementRecord.visibleText((values[1] as? String) ?? ""), (values[2] as? Bool) != false,
                MenuRules.shortcut(char: values[3] as? String, modifiers: (values[4] as? NSNumber)?.intValue), child)
    }

    /// The enabled commands of the app's menu bar, read once without opening a menu.
    func menuCatalog(_ app: AppIdentity, deadline: TimeInterval = 0.6) -> (entries: [MenuEntry], truncated: Bool) {
        let end = ProcessInfo.processInfo.systemUptime + deadline
        var entries: [MenuEntry] = []
        var truncated = false
        func walk(_ menu: AXUIElement, _ path: [String]) {
            for item in attribute(menu, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
                guard entries.count < MenuRules.maxEntries, ProcessInfo.processInfo.systemUptime < end else { truncated = true; return }
                guard let facts = menuItemFacts(item), !facts.title.isEmpty, !MenuRules.blocked(title: facts.title, shortcut: facts.shortcut) else { continue }
                if let child = facts.submenu {
                    // Disabled submenus hold nothing runnable; recent documents are not commands.
                    if facts.enabled, path.count + 1 < MenuRules.maxDepth { walk(child, path + [facts.title]) }
                } else if facts.enabled {
                    entries.append(MenuEntry(path: path + [facts.title], shortcut: facts.shortcut.map { NativeKey.chord($0.key, $0.flags) }))
                }
            }
        }
        for (title, item) in offeredMenus(app) {
            guard let menu = submenu(item) else { continue }
            walk(menu, [title])
            if truncated { break }
        }
        return (entries, truncated)
    }

    /// Finds a command by its titles in the live menu bar, applying the same rules as the catalog.
    func menuTarget(_ path: [String], app: AppIdentity) throws -> MenuTarget {
        try MenuRules.validatePath(path)
        guard let first = path.first, let top = offeredMenus(app).first(where: { MenuRules.same($0.title, first) }) else {
            throw UseError("menu_item_unavailable", "That menu is not offered. Use a path from the observation's menus.", next: "observe")
        }
        var current = top.item
        for title in path.dropFirst() {
            guard let menu = submenu(current), let item = menuChildren(menu).first(where: { MenuRules.same(menuTitle($0), title) }) else {
                throw UseError("menu_item_unavailable", "That menu command was not found. Use a path from the observation's menus.", next: "observe")
            }
            guard !MenuRules.blocked(title: menuTitle(item), shortcut: menuShortcut(item)) else {
                throw UseError("blocked_menu_item", "Quit, Close, Hide, Minimize and clipboard commands are unavailable from menus too.", next: "observe")
            }
            current = item
        }
        guard path.count > 1, submenu(current) == nil else {
            throw UseError("menu_item_unavailable", "Name a command, not a menu that holds others.", next: "observe")
        }
        guard (attribute(current, kAXEnabledAttribute) as? Bool) != false else {
            throw UseError("menu_item_disabled", "That menu command is disabled right now. Select what it acts on first.", next: "observe")
        }
        return MenuTarget(item: current, titleFrame: screenFrame(top.item), shortcut: menuShortcut(current).map { NativeKey.chord($0.key, $0.flags) })
    }
}
