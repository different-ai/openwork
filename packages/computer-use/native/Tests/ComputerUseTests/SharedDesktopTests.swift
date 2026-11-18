import XCTest
@testable import ComputerUse

final class SharedDesktopTests: XCTestCase {
    func testOnlyTypingOrAHeldButtonIsBusy() {
        XCTAssertTrue(SharedDesktop.personBusy(keyAt: 99.9, buttonDown: false, now: 100))
        XCTAssertTrue(SharedDesktop.personBusy(keyAt: 0, buttonDown: true, now: 100))
        XCTAssertFalse(SharedDesktop.personBusy(keyAt: 99, buttonDown: false, now: 100))
    }

    func testAClickOrKeyAfterTheMomentBeganInterruptsIt() {
        XCTAssertTrue(SharedDesktop.personInterrupted(inputAt: 10.3, since: 10))
        XCTAssertFalse(SharedDesktop.personInterrupted(inputAt: 9.9, since: 10))
        // Even a millisecond after the moment began, and right after the agent's own
        // input: device input is never discounted by timing.
        XCTAssertTrue(SharedDesktop.personInterrupted(inputAt: 10.001, since: 10))
        XCTAssertEqual(SharedDesktop.interrupted.next, "observe")
    }

    @MainActor
    func testTheAgentGoesRightAwayWhenThePersonIsNotTyping() async throws {
        var events: [String] = []
        try await SharedDesktop.takeGap(busy: { false }, now: { 0 }, check: {
            events.append("check")
        }, sleep: { _ in events.append("sleep") })
        XCTAssertEqual(events, ["check"])
    }

    @MainActor
    func testTheAgentTakesTheNextGapInTyping() async throws {
        var clock: TimeInterval = 0
        try await SharedDesktop.takeGap(busy: { clock < 0.15 }, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertGreaterThanOrEqual(clock, 0.15)
        XCTAssertLessThan(clock, 0.25)
    }

    @MainActor
    func testNonstopTypingDelaysTheAgentAtMostHalfASecond() async throws {
        var clock: TimeInterval = 0
        try await SharedDesktop.takeGap(busy: { true }, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertGreaterThanOrEqual(clock, SharedDesktop.deferLimit)
        XCTAssertLessThan(clock, SharedDesktop.deferLimit + SharedDesktop.poll * 2)
    }

    @MainActor
    func testTakeOverWhileDeferringStopsTheStep() async throws {
        var clock: TimeInterval = 0
        do {
            try await SharedDesktop.takeGap(busy: { true }, now: { clock }, check: {
                if clock > 0.1 { throw UseError("session_paused", "The person took over", next: "human_takeover") }
            }, sleep: { clock += $0 })
            XCTFail("The step outlived Take over")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_paused")
        }
    }

    @MainActor
    func testTypingWhileTheWindowComesForwardStopsTheStep() async throws {
        var clock: TimeInterval = 10
        var lastInput: TimeInterval = 9
        do {
            try await SharedDesktop.acquire(now: { clock }, buttonDown: { false }, focus: {
                // The person presses a key while the window is coming forward.
                clock += 0.1
                lastInput = clock
            }, interrupted: { lastInput > $0 })
            XCTFail("Control continued after the person typed during focus")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "person_interrupted")
            XCTAssertEqual(error.next, "observe")
        }
    }

    @MainActor
    func testAHeldButtonNeverLetsTheWindowComeForward() async throws {
        var focused = false
        do {
            // A drag the person began in another app, held past the half-second wait.
            try await SharedDesktop.acquire(now: { 10 }, buttonDown: { true }, focus: { focused = true }, interrupted: { _ in false })
            XCTFail("The window came forward under a held button")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "person_interrupted")
        }
        XCTAssertFalse(focused)
    }

    @MainActor
    func testInputBeforeTheWindowCameForwardDoesNotStopTheStep() async throws {
        var focused = false
        try await SharedDesktop.acquire(now: { 10 }, buttonDown: { false }, focus: { focused = true }, interrupted: { 9.8 > $0 })
        XCTAssertTrue(focused)
        do {
            try await SharedDesktop.acquire(now: { 10 }, buttonDown: { false }, focus: {
                throw UseError("window_unavailable", "Closed", next: "human_takeover")
            }, interrupted: { _ in false })
            XCTFail("A failed focus was reported as success")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "window_unavailable")
        }
    }

    func testTheFrontGoesBackToTheAppThatHadIt() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, host: 1, at: 10)
        // A second raise in the same moment does not replace who had the front.
        handBack.record(frontmost: 50, target: 7, own: 3, host: 1, at: 11)
        XCTAssertEqual(handBack.take(frontmost: 7, target: 7, lastKey: 9, lastClick: 9), 40)
        XCTAssertNil(handBack.pid)
        // The target itself and the helper are never handed the front.
        handBack.record(frontmost: 7, target: 7, own: 3, host: 1, at: 12)
        handBack.record(frontmost: 3, target: 7, own: 3, host: 1, at: 12)
        XCTAssertNil(handBack.pid)
    }

    func testAPersonWhoAlreadyMovedOnIsLeftWhereTheyAre() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, host: 1, at: 10)
        XCTAssertNil(handBack.take(frontmost: 60, target: 7, lastKey: 9, lastClick: 9))
        XCTAssertNil(handBack.pid)
        handBack.record(frontmost: 40, target: 7, own: 3, host: 1, at: 10)
        handBack.forget()
        XCTAssertNil(handBack.take(frontmost: 7, target: 7, lastKey: 9, lastClick: 9))
    }

    func testTakenFromOpenWorkTheFrontStaysUntilThePersonGoesBack() {
        var handBack = SharedDesktop.HandBack()
        // The person asked from the chat and is watching: no hand-back after each step.
        handBack.record(frontmost: 5, target: 7, own: 3, host: 5, at: 10)
        XCTAssertFalse(handBack.eachMoment)
        XCTAssertEqual(handBack.pid, 5, "the chat still gets the front back when the session ends")
        // Later steps find the agent's window still in front.
        handBack.record(frontmost: 7, target: 7, own: 3, host: 5, at: 11)
        XCTAssertFalse(handBack.eachMoment)
        // The person went back to the chat while the agent worked: from now on each step gives it back.
        handBack.record(frontmost: 5, target: 7, own: 3, host: 5, at: 12)
        XCTAssertTrue(handBack.eachMoment)
        XCTAssertEqual(handBack.take(frontmost: 7, target: 7, lastKey: 9, lastClick: 9), 5)
        handBack.record(frontmost: 5, target: 7, own: 3, host: 5, at: 13)
        XCTAssertTrue(handBack.eachMoment, "once the person wants it back, it stays that way for the session")
        handBack.reset()
        XCTAssertFalse(handBack.eachMoment)
        XCTAssertNil(handBack.pid)
    }

    func testTakenFromThePersonsOtherWorkTheFrontGoesBackEachStep() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, host: 5, at: 10)
        XCTAssertTrue(handBack.eachMoment, "their keys must not land in the agent's window between steps")
        var interrupted = SharedDesktop.HandBack()
        interrupted.record(frontmost: 5, target: 7, own: 3, host: 5, at: 10)
        // A step the person interrupted forgets who had the front, but not that something moved it.
        interrupted.forget()
        interrupted.record(frontmost: 40, target: 7, own: 3, host: 5, at: 11)
        XCTAssertTrue(interrupted.eachMoment)
    }

    func testTypingInTheAgentsWindowKeepsTheFrontThere() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, host: 1, at: 10)
        // A key of the person's moments after the front was taken keeps it in the
        // agent's window, so their later keys stay there too.
        XCTAssertNil(handBack.take(frontmost: 7, target: 7, lastKey: 10.02, lastClick: 9))
        XCTAssertNil(handBack.pid)
    }

    @MainActor
    func testWindowInFrontIsLeftAlone() async throws {
        var used = 0
        var focused = 0
        let refocused = try await SharedDesktop.returnFocus(used: &used, inFront: { true }, focus: { focused += 1 })
        XCTAssertFalse(refocused)
        XCTAssertEqual(used, 0)
        XCTAssertEqual(focused, 0)
    }

    @MainActor
    func testAPersonAtWorkSinceTheStepBeganKeepsTheFront() async throws {
        var used = 0
        var focused = 0
        do {
            // They typed while the agent waited for a gap: the window is never raised.
            _ = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, personActed: { true }, focus: { focused += 1 })
            XCTFail("The agent took the front from a person at work")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "person_interrupted")
        }
        XCTAssertEqual(focused, 0)
        XCTAssertEqual(used, 0)
    }

    @MainActor
    func testSwitchingAwayBringsTheWindowBackALimitedNumberOfTimes() async throws {
        var used = 0
        var focused = 0
        for _ in 0..<SharedDesktop.refocusLimit {
            let refocused = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, focus: { focused += 1 })
            XCTAssertTrue(refocused)
        }
        do {
            _ = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, focus: { focused += 1 })
            XCTFail("The agent kept taking the window back")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "focus_contested")
            XCTAssertEqual(error.next, "observe")
        }
        XCTAssertEqual(focused, SharedDesktop.refocusLimit)
    }

    @MainActor
    func testFocusThatDoesNotStickIsContestedNotATakeover() async throws {
        var used = 0
        do {
            _ = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, focus: {
                throw UseError("window_not_frontmost", "Choose Continue", next: "human_takeover")
            })
            XCTFail("Focus that did not stick was reported as success")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "focus_contested")
            XCTAssertEqual(error.next, "observe")
        }
        // A closed or changed window still stops the step as before.
        do {
            _ = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, focus: {
                throw UseError("window_unavailable", "Closed", next: "human_takeover")
            })
            XCTFail("A closed window was reported as focused")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "window_unavailable")
        }
    }

    func testAnotherWindowInFrontAsksTheModelToLookAgain() {
        let lost = SharedDesktop.yielding(UseError("window_not_frontmost", "Choose Continue", next: "human_takeover"))
        XCTAssertEqual(lost.code, "focus_lost")
        XCTAssertEqual(lost.next, "observe")
        let paused = SharedDesktop.yielding(UseError("session_paused", "Paused", next: "human_takeover"))
        XCTAssertEqual(paused.code, "session_paused")
        XCTAssertEqual(paused.next, "human_takeover")
        let other: Error = CancellationError()
        XCTAssertTrue(SharedDesktop.yielding(other) is CancellationError)
    }
    // MARK: Someone writing in a field

    func testWritingInAFieldLastsUntilARealPause() {
        // Half a second between words is still writing in a field, not elsewhere.
        XCTAssertTrue(SharedDesktop.personBusy(keyAt: 99.5, buttonDown: false, now: 100, inField: true))
        XCTAssertFalse(SharedDesktop.personBusy(keyAt: 99.5, buttonDown: false, now: 100))
        XCTAssertFalse(SharedDesktop.personBusy(keyAt: 100 - SharedDesktop.typingPause - 0.01, buttonDown: false, now: 100, inField: true))
        XCTAssertGreaterThan(SharedDesktop.typingPause, SharedDesktop.typingGap)
    }

    func testOnlyAFocusedTextFieldCountsAsWriting() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox"] {
            XCTAssertTrue(SharedDesktop.editsText(role: role, editableAncestor: false), role)
        }
        // Web content inside a contenteditable editor.
        XCTAssertTrue(SharedDesktop.editsText(role: "AXGroup", editableAncestor: true))
        for role in ["AXButton", "AXWebArea", "AXList", nil] {
            XCTAssertFalse(SharedDesktop.editsText(role: role, editableAncestor: false), role ?? "none")
        }
        var read = 0
        XCTAssertTrue(SharedDesktop.personTyping(keyAt: 99.6, now: 100, frontIsHost: false, focusEditsText: { read += 1; return true }))
        XCTAssertFalse(SharedDesktop.personTyping(keyAt: 99.6, now: 100, frontIsHost: false, focusEditsText: { read += 1; return false }))
        XCTAssertEqual(read, 2)
        // No recent key: the focused element is not even read.
        XCTAssertFalse(SharedDesktop.personTyping(keyAt: 90, now: 100, frontIsHost: true, focusEditsText: { read += 1; return true }))
        XCTAssertEqual(read, 2)
    }

    func testTypingInOpenWorksComposerCountsAsWriting() {
        // OpenWork's web content may not name its focused field; a recent key there is the composer.
        XCTAssertTrue(SharedDesktop.personTyping(keyAt: 99.6, now: 100, frontIsHost: true, focusEditsText: { false }))
    }

    @MainActor
    func testWritingInAFieldDefersTheAgentUpToTheTypingLimit() async throws {
        var clock: TimeInterval = 0
        let waited = try await SharedDesktop.takeGap(busy: { true }, limit: SharedDesktop.typingDeferLimit, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertGreaterThanOrEqual(waited, SharedDesktop.typingDeferLimit)
        XCTAssertLessThan(waited, SharedDesktop.typingDeferLimit + SharedDesktop.poll * 2)
        // A person who pauses after 1.3 s lets the agent go then, well before the limit.
        clock = 0
        let paused = try await SharedDesktop.takeGap(busy: { clock < 1.3 }, limit: SharedDesktop.typingDeferLimit, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertEqual(paused, 1.3, accuracy: SharedDesktop.poll * 1.5)
    }

    @MainActor
    func testWithNoFieldFocusedTheShortGapStays() async throws {
        var clock: TimeInterval = 0
        let waited = try await SharedDesktop.takeGap(busy: { true }, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertLessThan(waited, SharedDesktop.deferLimit + SharedDesktop.poll * 2)
        let none = try await SharedDesktop.takeGap(busy: { false }, now: { 5 }, check: {}, sleep: { _ in XCTFail("slept") })
        XCTAssertEqual(none, 0, "no wait is reported when the person was not busy")
    }

    @MainActor
    func testThePersonGetsTheirWindowFieldAndCaretBack() {
        var events: [String] = []
        let place = SharedDesktop.Place<String>(pid: 40, window: "window", field: "field", selection: CFRange(location: 12, length: 0), inField: true)
        let returned = SharedDesktop.restore(place, activate: { events.append("activate") }, raise: { events.append("raise \($0)"); return true },
            focus: { events.append("focus \($0)"); return true }, select: { events.append("select \($0) \($1.location)") })
        XCTAssertEqual(returned, .field)
        XCTAssertEqual(events, ["raise window", "activate", "focus field", "select field 12"])
    }

    @MainActor
    func testWhatNoLongerExistsFallsBackToActivatingTheApp() {
        var events: [String] = []
        func restore(_ place: SharedDesktop.Place<String>?, window: Bool = true, field: Bool = true) -> SharedDesktop.Returned {
            events = []
            return SharedDesktop.restore(place, activate: { events.append("activate") }, raise: { _ in window },
                focus: { _ in field }, select: { _, _ in events.append("select") })
        }
        let place = SharedDesktop.Place<String>(pid: 40, window: "window", field: "field", selection: CFRange(location: 3, length: 2), inField: true)
        // The window closed: today's app activate, nothing else.
        XCTAssertEqual(restore(place, window: false), .app)
        XCTAssertEqual(events, ["activate"])
        // The field is gone: the window comes back, the caret is not set anywhere.
        XCTAssertEqual(restore(place, field: false), .window)
        XCTAssertEqual(events, ["activate"])
        // Nothing was read, as when the place could not be read at all.
        XCTAssertEqual(restore(nil), .app)
        XCTAssertEqual(restore(SharedDesktop.Place<String>(pid: 40)), .app)
        XCTAssertEqual(events, ["activate"])
    }

    func testTakenWhileTheyWriteTheFrontGoesBackAtOnce() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, host: 5, at: 10, typing: true, inField: true)
        XCTAssertTrue(handBack.immediate, "no handBackDelay while they are writing")
        XCTAssertEqual(handBack.take(frontmost: 7, target: 7, lastKey: 9, lastClick: 9), 40)
        XCTAssertFalse(handBack.immediate, "only that moment")
        XCTAssertTrue(handBack.eachMoment)
    }

    func testTakenWhileTheyWriteInOpenWorkTheFrontGoesBackEachStep() {
        var handBack = SharedDesktop.HandBack()
        // Typing in the composer while the agent works: not a person watching the agent.
        handBack.record(frontmost: 5, target: 7, own: 3, host: 5, at: 10, typing: true)
        XCTAssertTrue(handBack.eachMoment)
        XCTAssertTrue(handBack.immediate)
        XCTAssertEqual(handBack.take(frontmost: 7, target: 7, lastKey: 9, lastClick: 9), 5)
    }

    func testTypingInTheChatWhileTheAgentHeldTheFrontGetsItBack() {
        var handBack = SharedDesktop.HandBack()
        // Taken from OpenWork and held between steps while the person watched.
        handBack.beginMoment()
        handBack.record(frontmost: 5, target: 7, own: 3, host: 5, at: 10)
        XCTAssertFalse(handBack.eachMoment)
        // A later step finds them typing in the composer: a new take from there and then.
        handBack.beginMoment()
        handBack.record(frontmost: 5, target: 7, own: 3, host: 5, at: 20, typing: true)
        XCTAssertEqual(handBack.takenAt, 20)
        XCTAssertTrue(handBack.immediate)
        // Their click into the chat and their typing came before this take, not after it.
        XCTAssertEqual(handBack.take(frontmost: 7, target: 7, lastKey: 19.5, lastClick: 15), 5)
        // Within one moment, the first app in front still wins.
        handBack.beginMoment()
        handBack.record(frontmost: 40, target: 7, own: 3, host: 5, at: 30)
        handBack.record(frontmost: 50, target: 7, own: 3, host: 5, at: 31)
        XCTAssertEqual(handBack.pid, 40)
    }

    func testKeysMeantForTheirFieldSendTheFrontBack() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, host: 1, at: 10, inField: true)
        // They kept typing and their keys reached the agent's window: back to their field,
        // instead of the front staying with the agent for good.
        XCTAssertEqual(handBack.take(frontmost: 7, target: 7, lastKey: 10.3, lastClick: 9), 40)
        // A click in the agent's window still means they chose it.
        handBack.record(frontmost: 40, target: 7, own: 3, host: 1, at: 10, inField: true)
        XCTAssertNil(handBack.take(frontmost: 7, target: 7, lastKey: 10.3, lastClick: 10.2))
    }

    func testAStepStoppedByKeysForTheirFieldHandsBackImmediately() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, host: 5, at: 10, inField: true)
        handBack.interrupted(clicked: false)
        XCTAssertEqual(handBack.pid, 40)
        XCTAssertTrue(handBack.immediate)
        XCTAssertTrue(handBack.eachMoment)
        // A click stops the step and leaves the front where it is, as before.
        var clicked = SharedDesktop.HandBack()
        clicked.record(frontmost: 40, target: 7, own: 3, host: 5, at: 10, inField: true)
        clicked.interrupted(clicked: true)
        XCTAssertNil(clicked.pid)
        // So do keys from someone who was not writing in a field.
        var elsewhere = SharedDesktop.HandBack()
        elsewhere.record(frontmost: 40, target: 7, own: 3, host: 5, at: 10)
        elsewhere.interrupted(clicked: false)
        XCTAssertNil(elsewhere.pid)
        XCTAssertFalse(elsewhere.immediate)
    }
    // MARK: The person's input pauses a step; it never stops the agent

    @MainActor
    func testAClickMidBatchPausesAndFinishesTheUnsentSteps() async throws {
        // Three steps; the person clicks just before the second one goes out.
        let batch: [Action] = [.press("a"), .press("b"), .press("c")]
        var sent: [String] = []
        var clicked = false
        var index = 0
        var pauses = 0
        while index < batch.count {
            do {
                if index == 1, !clicked { clicked = true; throw SharedDesktop.interrupted }
                if case .press(let ref) = batch[index] { sent.append(ref) }
                index += 1
            } catch where SharedDesktop.isPersonInput(error) {
                guard case .resend = SharedDesktop.resumption(of: batch[index], mayHaveActed: false, typed: 0) else {
                    return XCTFail("a step that sent nothing is sent again")
                }
                var clock: TimeInterval = 0
                // They stop clicking at 0.4 s; the step goes again a second later.
                let idle = try await SharedDesktop.waitForIdle(lastInput: { 0.4 }, buttonDown: { false }, limit: SharedDesktop.busyLimit,
                    now: { clock }, check: {}, sleep: { clock += $0 })
                XCTAssertTrue(idle)
                XCTAssertEqual(clock, 0.4 + SharedDesktop.typingPause, accuracy: SharedDesktop.poll * 1.5)
                pauses += 1
            }
        }
        XCTAssertEqual(sent, ["a", "b", "c"])
        XCTAssertEqual(pauses, 1)
        // Raised as an input failure too, the same way.
        XCTAssertTrue(SharedDesktop.isPersonInput(InputFailure(cause: SharedDesktop.interrupted, mayHaveActed: false)))
        XCTAssertFalse(SharedDesktop.isPersonInput(SharedDesktop.contested))
    }

    func testAStepThatMayHaveActedIsNeverSentAgain() {
        for action: Action in [.click(.zero, 1, []), .press("a"), .key("return", []), .drag([.zero, CGPoint(x: 5, y: 5)])] {
            guard case .stop(let calm) = SharedDesktop.resumption(of: action, mayHaveActed: true, typed: 0) else {
                XCTFail("\(action.name) would be sent again"); continue
            }
            XCTAssertEqual(calm.code, "person_paused_step")
            XCTAssertEqual(calm.next, "observe", "the host appends a fresh observation")
        }
        guard case .stop(let drag) = SharedDesktop.resumption(of: .drag([.zero]), mayHaveActed: true, typed: 0) else { return XCTFail() }
        XCTAssertTrue(drag.message.contains("drag"))
    }

    @MainActor
    func testInterruptedTypingResumesWithoutDuplicateCharacters() async throws {
        let text = "Hello, world"
        var field = ""
        var typed = 0
        var interruptAfter: Int? = 4
        func send(_ character: String) {
            // As MacInput counts: the moment the key goes out, before any check that follows.
            field += character; typed += 1
        }
        func check() throws { if let limit = interruptAfter, typed >= limit { interruptAfter = nil; throw SharedDesktop.interrupted } }
        do {
            try await InputDispatch.type(text, check: check, validate: {}, send: send, pace: {})
            XCTFail("the person's keys did not pause typing")
        } catch where SharedDesktop.isPersonInput(error) {}
        let start = CFRange(location: 10, length: 0)
        guard case .typeRest(let sent, let rest) = SharedDesktop.resumption(of: .type(text), mayHaveActed: true, typed: typed) else {
            return XCTFail("typing that stopped partway resumes")
        }
        XCTAssertEqual(sent, "Hell")
        // The caret is still right after the agent's own text.
        XCTAssertTrue(SharedDesktop.caretUnmoved(start: start, sent: sent, now: CFRange(location: 14, length: 0)))
        typed = 0
        try await InputDispatch.type(rest, check: check, validate: {}, send: send, pace: {})
        XCTAssertEqual(field, text)
        // Every character went out before the pause: nothing is typed again.
        guard case .done = SharedDesktop.resumption(of: .type("ab"), mayHaveActed: true, typed: 2) else { return XCTFail() }
    }

    func testTypingResumesOnlyWhereTheAgentLeftTheCaret() {
        let start = CFRange(location: 3, length: 2)
        // Replacing a selection: the caret lands after the agent's text, whatever was selected.
        XCTAssertTrue(SharedDesktop.caretUnmoved(start: start, sent: "é😀", now: CFRange(location: 3 + 3, length: 0)))
        // The person clicked elsewhere in the field, selected text or typed into it.
        XCTAssertFalse(SharedDesktop.caretUnmoved(start: start, sent: "ab", now: CFRange(location: 0, length: 0)))
        XCTAssertFalse(SharedDesktop.caretUnmoved(start: start, sent: "ab", now: CFRange(location: 5, length: 3)))
        XCTAssertFalse(SharedDesktop.caretUnmoved(start: start, sent: "ab", now: CFRange(location: 7, length: 0)))
        // A field whose caret cannot be read is not typed into blind.
        XCTAssertFalse(SharedDesktop.caretUnmoved(start: nil, sent: "ab", now: CFRange(location: 5, length: 0)))
        XCTAssertFalse(SharedDesktop.caretUnmoved(start: start, sent: "ab", now: nil))
    }

    @MainActor
    func testAPersonBusyPastTheCapGetsPersonBusyNotAHandover() async throws {
        var clock: TimeInterval = 0
        // Typing nonstop, then a button held down: mouse moves alone would not count.
        let idle = try await SharedDesktop.waitForIdle(lastInput: { clock }, buttonDown: { clock > 30 }, limit: SharedDesktop.busyLimit,
            now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertFalse(idle)
        XCTAssertGreaterThanOrEqual(clock, SharedDesktop.busyLimit)
        XCTAssertLessThan(clock, SharedDesktop.busyLimit + SharedDesktop.poll * 2)
        XCTAssertEqual(SharedDesktop.busy.code, "person_busy")
        XCTAssertEqual(SharedDesktop.busy.next, "wait")
        for message in [SharedDesktop.busy.message, SharedDesktop.interrupted.message, SharedDesktop.pausedStep("x").message] {
            XCTAssertFalse(message.contains("theirs"), message)
        }
        // Idle already: no wait at all.
        clock = 100
        let already = try await SharedDesktop.waitForIdle(lastInput: { 90 }, buttonDown: { false }, limit: 60, now: { clock }, check: {},
            sleep: { _ in XCTFail("slept") })
        XCTAssertTrue(already)
    }

    @MainActor
    func testTakeOverDuringAPauseStillWaitsForContinue() async throws {
        var clock: TimeInterval = 0
        do {
            _ = try await SharedDesktop.waitForIdle(lastInput: { clock }, buttonDown: { false }, limit: SharedDesktop.busyLimit, now: { clock }, check: {
                if clock > 2 { throw UseError("session_paused", "The person took over", next: "human_takeover") }
            }, sleep: { clock += $0 })
            XCTFail("the pause outlived Take over")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_paused")
            XCTAssertEqual(error.next, "human_takeover")
        }
    }

    func testAfterAPauseAChangedWindowIsToldCalmly() {
        for code in ["stale_observation", "focus_changed", "focus_lost"] {
            XCTAssertEqual(SharedDesktop.afterPause(UseError(code, "Changed", next: "observe")).code, "person_paused_step", code)
        }
        // Take over, Stop and another app fighting for the front keep their meaning.
        for error in [UseError("session_paused", "Paused", next: "human_takeover"), SharedDesktop.contested,
                      UseError("session_changed", "Stopped", next: "human_takeover"), UseError("protected_input", "No", next: "human_takeover")] {
            XCTAssertEqual(SharedDesktop.afterPause(error).code, error.code)
        }
    }

    @MainActor
    func testAnIgnoredActivationFallsBackUntilTheWindowReadsBackInFront() async throws {
        // macOS 26 answers activate with true and does nothing; the app makes its window main when asked.
        var tried: [WindowFront.Way] = []
        var front = false
        let way = try await WindowFront.bring(attempt: { way in
            tried.append(way)
            if way == .mainWindow { front = true }
        }, inFront: { front }, check: {}, sleep: { _ in })
        XCTAssertEqual(way, .mainWindow)
        XCTAssertEqual(tried, [.raise, .frontmost, .mainWindow], "each way once, in order, stopping at the first that reads back")
    }

    @MainActor
    func testAWindowAlreadyComingForwardTakesNothingMore() async throws {
        var tried: [WindowFront.Way] = []
        var reads = 0
        let way = try await WindowFront.bring(attempt: { tried.append($0) }, inFront: { reads += 1; return reads > 2 }, check: {}, sleep: { _ in })
        XCTAssertEqual(way, .raise)
        XCTAssertEqual(tried, [.raise], "a slow app that comes forward within the read-back is not pushed again")
    }

    @MainActor
    func testAWindowThatNeverComesForwardIsRefusedBeforeInput() async throws {
        var tried: [WindowFront.Way] = []
        do {
            _ = try await WindowFront.bring(attempt: { tried.append($0) }, inFront: { false }, check: {}, sleep: { _ in })
            XCTFail("expected a refusal")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "front_unavailable")
            XCTAssertEqual(error.next, "observe")
        }
        XCTAssertEqual(tried, WindowFront.Way.allCases, "every way is tried once, never in a loop")
    }

    @MainActor
    func testControlChangingWhileTheWindowComesForwardStopsTheFallbacks() async throws {
        var tried: [WindowFront.Way] = []
        do {
            _ = try await WindowFront.bring(attempt: { tried.append($0) }, inFront: { false }, check: {
                if tried.count > 1 { throw UseError("session_changed", "Control changed during focus.", next: "observe") }
            }, sleep: { _ in })
            XCTFail("expected the change to stop it")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_changed")
        }
        XCTAssertEqual(tried, [.raise, .frontmost])
    }
}
