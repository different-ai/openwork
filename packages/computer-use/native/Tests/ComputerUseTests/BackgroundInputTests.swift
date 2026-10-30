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
        XCTAssertTrue(InputDelivery.stepNeedsFront(.type("hi"), route: .skyLight, signedKeys: false), "Chromium keys need a signed envelope")
        XCTAssertTrue(InputDelivery.stepNeedsFront(.key("enter", []), route: .skyLight, signedKeys: false))
    }

    func testSignedKeysLetChromiumTypeInTheBackground() {
        XCTAssertFalse(InputDelivery.stepNeedsFront(.type("hi"), route: .skyLight, signedKeys: true))
        XCTAssertFalse(InputDelivery.stepNeedsFront(.key("enter", []), route: .skyLight, signedKeys: true))
        // Menu shortcuts still need the front, signed or not.
        XCTAssertTrue(InputDelivery.stepNeedsFront(.key("s", .maskCommand), route: .skyLight, signedKeys: true))
    }

    func testKeyEventsExposeTheirWindowServerRecord() throws {
        let event = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true))
        XCTAssertNotNil(KeyAuthentication.record(event))
        if ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0)) {
            XCTAssertTrue(KeyAuthentication.available, "macOS 15 and later can sign background keys")
        }
    }

    func testOnlyChromiumAndElectronGetTheLegacyAccessibilityRequest() {
        XCTAssertTrue(PointerRoute.isChromium(bundleID: "com.google.Chrome", info: [:]))
        XCTAssertTrue(PointerRoute.isChromium(bundleID: "com.example.Chat", info: ["ElectronAsarIntegrity": [:]]))
        XCTAssertFalse(PointerRoute.isChromium(bundleID: "com.example.Pad", info: ["UIDeviceFamily": [2, 6]]), "Catalyst is not Chromium")
        XCTAssertFalse(PointerRoute.isChromium(bundleID: "com.apple.TextEdit", info: [:]))
        XCTAssertTrue(ChromiumAccessibility.useLegacyRequest(chromium: true, manual: .attributeUnsupported))
        XCTAssertFalse(ChromiumAccessibility.useLegacyRequest(chromium: false, manual: .attributeUnsupported), "native apps never get it")
        XCTAssertFalse(ChromiumAccessibility.useLegacyRequest(chromium: true, manual: .cannotComplete), "a busy app is not an unsupported one")
        XCTAssertFalse(ChromiumAccessibility.useLegacyRequest(chromium: true, manual: .success))
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
        XCTAssertTrue(ImagePolicy.include(requested: nil, automatic: true, namedControls: 20, interactiveControls: 60), "a mostly unnamed tree cannot be acted on by name")
        XCTAssertFalse(ImagePolicy.include(requested: nil, automatic: true, namedControls: 20, interactiveControls: 40))
    }

    func testReadingModesAndBackgroundDeliveryReadTheTreeFirst() {
        XCTAssertTrue(ImagePolicy.automatic(delivery: .foreground, mode: .assist, policy: .embedded))
        XCTAssertTrue(ImagePolicy.automatic(delivery: .foreground, mode: .observe, policy: .embedded))
        XCTAssertTrue(ImagePolicy.automatic(delivery: .background, mode: .control, policy: .embedded))
        XCTAssertFalse(ImagePolicy.automatic(delivery: .foreground, mode: .control, policy: .embedded), "foreground control keeps its screenshot for coordinates")
        XCTAssertFalse(ImagePolicy.automatic(delivery: .foreground, mode: .assist, policy: .desktop), "the standalone helper keeps today's default")
    }

    func testOnlyControlModeKeepsTheSharperImage() {
        XCTAssertEqual(ImagePolicy.profile(mode: .control, policy: .embedded), ImagePolicy.precise)
        XCTAssertEqual(ImagePolicy.profile(mode: .assist, policy: .embedded), ImagePolicy.reading)
        XCTAssertEqual(ImagePolicy.profile(mode: .observe, policy: .embedded), ImagePolicy.reading)
        XCTAssertEqual(ImagePolicy.profile(mode: .observe, policy: .desktop), ImagePolicy.precise)
        XCTAssertLessThan(ImagePolicy.reading.maxLongSide, ImagePolicy.precise.maxLongSide)
    }

    func testAnUnchangedAutomaticImageIsNotSentAgain() {
        let digest = Data([1, 2, 3])
        let last = ImagePolicy.Sent(observationID: "first", generation: 2, window: 7, width: 800, height: 600, digest: digest)
        func repeated(_ requested: Bool? = nil, generation: Int = 2, window: CGWindowID = 7, width: Int = 800, digest: Data = digest) -> String? {
            ImagePolicy.alreadySent(requested: requested, last: last, generation: generation, window: window, width: width, height: 600, digest: digest)?.observationID
        }
        XCTAssertEqual(repeated(), "first")
        XCTAssertNil(repeated(true), "an explicit request always sends the image")
        XCTAssertNil(repeated(digest: Data([9])), "changed pixels are sent")
        XCTAssertNil(repeated(generation: 3), "a handoff or dialog change sends a fresh image")
        XCTAssertNil(repeated(window: 8), "another window's image is sent")
        XCTAssertNil(repeated(width: 801), "a resized window's image is sent")
        XCTAssertNil(ImagePolicy.alreadySent(requested: nil, last: nil, generation: 2, window: 7, width: 800, height: 600, digest: digest))
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
