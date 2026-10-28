import XCTest
@testable import ComputerUse

final class BackgroundInputTests: XCTestCase {
    func testOnlyControlSessionsOnASupportedMacWorkInTheBackground() {
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: true, mode: .control, bundleID: "com.apple.TextEdit"), .background)
        XCTAssertEqual(InputDelivery.decide(enabled: false, available: true, mode: .control, bundleID: "com.apple.TextEdit"), .foreground)
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: false, mode: .control, bundleID: "com.apple.TextEdit"), .foreground,
            "a macOS without the private calls keeps the front")
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: true, mode: .assist, bundleID: "com.apple.TextEdit"), .foreground)
    }

    func testCanvasAppsGamesAndPointerToolkitsKeepTheFront() {
        func decide(_ id: String, info: [String: Any] = [:], frameworks: [String] = []) -> InputDelivery {
            InputDelivery.decide(enabled: true, available: true, mode: .control, bundleID: id, info: info, frameworks: frameworks)
        }
        XCTAssertEqual(decide("org.blenderfoundation.blender"), .foreground)
        XCTAssertEqual(decide("com.unity3d.UnityEditor5.x"), .foreground)
        XCTAssertEqual(decide("com.example.game", info: ["LSApplicationCategoryType": "public.app-category.action-games"]), .foreground)
        XCTAssertEqual(decide("com.example.qt", frameworks: ["QtCore.framework", "Sparkle.framework"]), .foreground)
        XCTAssertEqual(decide("com.google.Chrome", frameworks: ["Google Chrome Framework.framework"]), .background)
    }

    func testAppsThatTakeOnlyHardwareInputGetRealInputWhetherOrNotBackgroundIsOn() {
        XCTAssertTrue(InputDelivery.needsRealInput(bundleID: "org.blenderfoundation.blender"))
        XCTAssertTrue(InputDelivery.needsRealInput(bundleID: "com.epicgames.UnrealEditor"))
        XCTAssertTrue(InputDelivery.needsRealInput(bundleID: "com.example.game", info: ["LSApplicationCategoryType": "public.app-category.games"]))
        XCTAssertTrue(InputDelivery.needsRealInput(bundleID: "com.example.tk", frameworks: ["Tk.framework"]))
        for id in ["com.apple.TextEdit", "com.apple.finder", "com.google.Chrome", "com.apple.Music"] {
            XCTAssertFalse(InputDelivery.needsRealInput(bundleID: id, frameworks: ["Sparkle.framework"]), id)
        }
    }

    func testTheAgentsOwnRealInputIsNeverTakenForThePersons() {
        XCTAssertTrue(RealInput.isOwn(inputAt: 10.002, postedAt: 10))
        XCTAssertTrue(RealInput.isOwn(inputAt: 9.995, postedAt: 10), "the system can stamp the event just before the post returns")
        XCTAssertFalse(RealInput.isOwn(inputAt: 10 + RealInput.echo + 0.05, postedAt: 10), "a click after the agent's is the person's")
        XCTAssertFalse(RealInput.isOwn(inputAt: 10.03, postedAt: 10), "a person's click right after the agent's still stops the step")
        XCTAssertFalse(RealInput.isOwn(inputAt: 9.5, postedAt: 10))
        XCTAssertFalse(RealInput.isOwn(inputAt: 10, postedAt: nil), "without real input every click is the person's")
    }

    func testThePointerGoesBackOnlyIfThePersonLeftItWhereTheAgentPutIt() {
        let person = CGPoint(x: 100, y: 100), agent = CGPoint(x: 500, y: 400)
        XCTAssertEqual(RealInput.restore(to: person, current: agent, agentLast: agent), person)
        XCTAssertNil(RealInput.restore(to: person, current: CGPoint(x: 700, y: 20), agentLast: agent), "the person moved it")
        XCTAssertNil(RealInput.restore(to: nil, current: agent, agentLast: agent), "the pointer never moved")
    }

    func testRealInputIsSentOnlyWhileItStillLandsInTheSelectedApp() {
        let app: pid_t = 42, other: pid_t = 7, helper: pid_t = 99
        let selected: CGWindowID = 10, sibling: CGWindowID = 11, overlay: CGWindowID = 90, pill: CGWindowID = 91
        let bounds = CGRect(x: 0, y: 0, width: 800, height: 600)
        func reaches(front: pid_t? = 42, at point: CGPoint? = CGPoint(x: 400, y: 300), _ windows: [(id: CGWindowID, pid: pid_t, bounds: CGRect)]) -> Bool {
            RealInput.reachesTarget(app, window: selected, front: front, at: point, windows: windows, passThrough: [overlay])
        }
        XCTAssertTrue(reaches(at: nil, []))
        XCTAssertFalse(reaches(front: other, at: nil, []), "keys go to whatever app is in front")
        XCTAssertTrue(reaches([(overlay, helper, bounds), (selected, app, bounds)]), "the agent's see-through overlay is not in the way")
        XCTAssertFalse(reaches([(pill, helper, CGRect(x: 350, y: 250, width: 100, height: 100)), (selected, app, bounds)]),
            "the Take over pill takes clicks, so it is in the way")
        XCTAssertFalse(reaches([(sibling, app, CGRect(x: 300, y: 200, width: 200, height: 200)), (selected, app, bounds)]),
            "another window of the same app over the point")
        XCTAssertFalse(reaches([(5, other, CGRect(x: 300, y: 200, width: 200, height: 200)), (selected, app, bounds)]), "another app's window over the point")
        XCTAssertFalse(reaches(front: other, [(selected, app, bounds)]))
        XCTAssertFalse(reaches(at: CGPoint(x: 900, y: 300), [(selected, app, bounds)]))
    }

    func testBackgroundSessionsTakeTheFrontOnlyForStepsThatNeedIt() {
        let point = CGPoint(x: 10, y: 10)
        XCTAssertFalse(InputDelivery.stepNeedsFront(.click(point, 1, []), route: .appKit))
        XCTAssertFalse(InputDelivery.stepNeedsFront(.type("hi"), route: .appKit))
        XCTAssertFalse(InputDelivery.stepNeedsFront(.key("enter", []), route: .appKit))
        XCTAssertFalse(InputDelivery.stepNeedsFront(.scroll(point, 0, -3), route: .skyLight))
        XCTAssertFalse(InputDelivery.stepNeedsFront(.press("e1"), route: .skyLight))
        XCTAssertTrue(InputDelivery.stepNeedsFront(.key("s", .maskCommand), route: .appKit), "background keys never reach menus")
        XCTAssertTrue(InputDelivery.stepNeedsFront(.click(point, 1, .maskShift), route: .appKit))
        XCTAssertTrue(InputDelivery.stepNeedsFront(.move(point), route: .appKit))
        XCTAssertTrue(InputDelivery.stepNeedsFront(.drag([point, point]), route: .appKit))
        XCTAssertTrue(InputDelivery.stepNeedsFront(.type("hi"), route: .skyLight), "Chromium keys need a signed envelope")
    }

    func testClicksSendOnlyTheFocusRecordAndKeysAddTheMakeKeyPair() {
        let click = BackgroundFocus.records(window: 0x0102_0304, makeKey: false)
        let keys = BackgroundFocus.records(window: 0x0102_0304, makeKey: true)
        XCTAssertEqual(click.count, 1)
        XCTAssertEqual(keys.count, 3)
        for record in keys {
            XCTAssertEqual(record.count, 0xF8)
            XCTAssertEqual(record[0x04], 0xF8)
            XCTAssertEqual(Array(record[0x3C..<0x40]), [0x04, 0x03, 0x02, 0x01], "the window id is little-endian at 0x3C")
        }
        XCTAssertEqual(click[0], keys[0])
        XCTAssertEqual(keys.map { $0[0x08] }, [0x0D, 0x01, 0x02])
        XCTAssertEqual(keys[0][0x8A], 0x01)
        XCTAssertTrue(keys[0][0x20..<0x30].allSatisfy { $0 == 0 })
        for key in keys.dropFirst() {
            XCTAssertEqual(key[0x3A], 0x10)
            XCTAssertTrue(key[0x20..<0x30].allSatisfy { $0 == 0xFF })
        }
    }

    @MainActor
    func testKeysWaitUntilTheAppReportsTheWindowFocused() async throws {
        var focused = false, posts = 0, clock: TimeInterval = 0
        try await BackgroundFocus.primeKeys(routes: { focused }, post: { posts += 1; return true }, now: { clock }, check: {},
            sleep: { clock += $0; if posts == 1, clock >= 0.1 { focused = true } })
        XCTAssertEqual(posts, 1)
        posts = 0
        try await BackgroundFocus.primeKeys(routes: { true }, post: { posts += 1; return true }, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertEqual(posts, 0, "an app already focused on the window needs no records")
    }

    @MainActor
    func testKeysAreRefusedWhenTheAppNeverFocusesTheWindow() async {
        var posts = 0, clock: TimeInterval = 0
        do {
            try await BackgroundFocus.primeKeys(routes: { false }, post: { posts += 1; return true }, now: { clock }, check: {}, sleep: { clock += $0 })
            XCTFail("keys were allowed into a window the app never focused")
        } catch { XCTAssertEqual((error as? UseError)?.code, "background_keys_unavailable") }
        XCTAssertEqual(posts, BackgroundFocus.keyAttempts)
        do {
            try await BackgroundFocus.primeKeys(routes: { false }, post: { false }, now: { clock }, check: {}, sleep: { clock += $0 })
            XCTFail("keys were allowed when the records could not be posted")
        } catch { XCTAssertEqual((error as? UseError)?.code, "background_keys_unavailable") }
    }

    func testAutomaticImagesOnlyWhenTheTreeIsTooThin() {
        XCTAssertFalse(ImagePolicy.include(requested: nil, automatic: true, namedControls: ImagePolicy.enoughControls))
        XCTAssertTrue(ImagePolicy.include(requested: nil, automatic: true, namedControls: ImagePolicy.enoughControls - 1))
        XCTAssertTrue(ImagePolicy.include(requested: nil, automatic: false, namedControls: 100), "foreground sessions keep today's default")
        XCTAssertTrue(ImagePolicy.include(requested: true, automatic: true, namedControls: 100))
        XCTAssertFalse(ImagePolicy.include(requested: false, automatic: false, namedControls: 0))
    }

    func testObservationLeavesTheImageToTheSessionUnlessAsked() throws {
        XCTAssertNil(try ObservationOptions(["session_id": "s"], policy: .embedded).image)
        XCTAssertEqual(try ObservationOptions(["session_id": "s", "include_image": false], policy: .embedded).image, false)
        XCTAssertEqual(try ObservationOptions(["session_id": "s", "elements": "none"], policy: .embedded).image, true,
            "a request for no elements still gets the picture")
        XCTAssertThrowsError(try ObservationOptions(["session_id": "s", "include_image": false, "elements": "none"], policy: .embedded))
    }

    func testDesktopChangesNameWhatThePersonWouldNotice() {
        let before = DesktopState(frontPID: 10, cursor: CGPoint(x: 100, y: 100), space: 2)
        let still = before.changes(to: DesktopState(frontPID: 10, cursor: CGPoint(x: 100.2, y: 100), space: 2))
        XCTAssertEqual(still["front_app_changed"] as? Bool, false)
        XCTAssertEqual(still["cursor_moved"] as? Bool, false)
        XCTAssertEqual(still["space_changed"] as? Bool, false)
        let moved = before.changes(to: DesktopState(frontPID: 11, cursor: CGPoint(x: 140, y: 100), space: 3))
        XCTAssertEqual(moved["front_app_changed"] as? Bool, true)
        XCTAssertEqual(moved["cursor_moved"] as? Bool, true)
        XCTAssertEqual(moved["space_changed"] as? Bool, true)
    }
}
