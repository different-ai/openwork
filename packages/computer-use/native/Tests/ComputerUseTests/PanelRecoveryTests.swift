import XCTest
@testable import ComputerUse

/// QuickTime's Save sheet ignored Command-Shift-G twice, and PhotoCraft's Place panel was still
/// opening when open_in_panel arrived: both steps were refused although the panel was there.
final class PanelRecoveryTests: XCTestCase {
    @MainActor
    func testASaveSheetTriesEveryWayAPersonOpensGoTo() async throws {
        XCTAssertEqual(PanelGoTo.ways(save: true), [.shortcut, .expanded, .slashInName])
        var tried: [PanelGoTo.Way] = []
        // The collapsed sheet ignores the shortcut until it is expanded.
        let field = try await PanelGoTo.open(PanelGoTo.ways(save: true)) { way -> String? in
            tried.append(way); return way == .expanded ? "Go To" : nil
        }
        XCTAssertEqual(field, "Go To"); XCTAssertEqual(tried, [.shortcut, .expanded], "stops at the first way that opens it")
        tried = []
        let last = try await PanelGoTo.open(PanelGoTo.ways(save: true)) { way -> String? in tried.append(way); return way == .slashInName ? "Go To" : nil }
        XCTAssertEqual(last, "Go To"); XCTAssertEqual(tried, [.shortcut, .expanded, .slashInName])
    }

    @MainActor
    func testAnOpenPanelRetriesTheShortcutButTypesNothingIntoItsList() async throws {
        // Typing into an Open panel's file list would select files by name: only the shortcut, twice.
        XCTAssertEqual(PanelGoTo.ways(save: false), [.shortcut, .shortcut])
        var attempts = 0
        let none = try await PanelGoTo.open(PanelGoTo.ways(save: false)) { _ -> String? in attempts += 1; return nil }
        XCTAssertNil(none); XCTAssertEqual(attempts, 2)
    }

    @MainActor
    func testGoToStillReportsAFieldThatNeverOpened() async throws {
        let failure = try await PanelGoTo.enter("/tmp", open: { () -> String? in
            try await PanelGoTo.open(PanelGoTo.ways(save: true)) { _ in nil }
        }, set: { _, _ in true }, value: { _ in "/tmp" }, submit: { _ in })
        XCTAssertEqual(failure, .noField, "nothing is saved when no way opens Go To")
    }

    func testAPanelStillOpeningIsWaitedForBriefly() {
        XCTAssertEqual(OpenPanelRules.wait, 2)
        // A panel of its own window (an app-modal NSOpenPanel) is recognized by its contents, as a sheet is.
        XCTAssertTrue(DialogRules.isFilePanel(bundleID: "ai.storyteller.photocraft", roles: ["AXWindow", "AXOutline", "AXButton"], defaultButton: "Place"))
        XCTAssertTrue(OpenPanelRules.isOpenPanel(kind: .filePanel, saveField: false, defaultButton: "Place"))
        XCTAssertFalse(OpenPanelRules.isOpenPanel(kind: .window, saveField: false, defaultButton: "Place"), "an ordinary window is not a panel")
        XCTAssertFalse(OpenPanelRules.isOpenPanel(kind: .filePanel, saveField: true, defaultButton: "Save"), "a Save sheet is not an Open panel")
    }
}
