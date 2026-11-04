import XCTest
import AppKit
@testable import ComputerUse

final class FollowAlongTests: XCTestCase {
    private let openWork: pid_t = 100, app: pid_t = 200, other: pid_t = 300
    private let beside = CGRect(x: 720, y: 25, width: 720, height: 875)

    func testWatchingTheChatWorksInFrontAndPutsTheWindowBesideOpenWorkOnce() {
        var follow = FollowAlong(watching: true)
        XCTAssertTrue(follow.follows(frontmost: openWork, host: openWork, target: app))
        XCTAssertTrue(follow.follows(frontmost: app, host: openWork, target: app), "the agent's own window in front is still following")
        XCTAssertTrue(follow.arrangeNow(current: CGRect(x: 0, y: 0, width: 500, height: 400), arranged: nil))
        XCTAssertFalse(follow.arrangeNow(current: beside, arranged: beside), "not on every step")
    }

    func testAChatNotOnScreenWorksInTheBackgroundAndNeverArranges() {
        var follow = FollowAlong(watching: false)
        XCTAssertFalse(follow.follows(frontmost: openWork, host: openWork, target: app))
        XCTAssertFalse(follow.arrangeNow(current: nil, arranged: nil))
        // Another thread selected or OpenWork hidden: the host says so, and the session goes behind.
        follow = FollowAlong(watching: true)
        follow.host(watching: false)
        XCTAssertFalse(follow.follows(frontmost: openWork, host: openWork, target: app))
    }

    func testAnotherAppInFrontPushesTheWindowBehindUntilThePersonComesBack() {
        var follow = FollowAlong(watching: true)
        XCTAssertTrue(follow.follows(frontmost: app, host: openWork, target: app))
        _ = follow.arrangeNow(current: nil, arranged: nil)
        XCTAssertFalse(follow.follows(frontmost: other, host: openWork, target: app))
        // Clicking the agent's window again does not pull it forward for the agent.
        XCTAssertFalse(follow.follows(frontmost: app, host: openWork, target: app))
        // Back in OpenWork with the chat on screen: in front again, beside OpenWork once more.
        XCTAssertTrue(follow.follows(frontmost: openWork, host: openWork, target: app))
        XCTAssertTrue(follow.arrangeNow(current: beside, arranged: beside))
    }

    func testAMinimizedWindowStaysBehindUntilTheChatIsShownAgain() {
        var follow = FollowAlong(watching: true)
        XCTAssertFalse(follow.follows(frontmost: openWork, host: openWork, target: app, shown: false))
        XCTAssertFalse(follow.follows(frontmost: app, host: openWork, target: app))
        follow.host(watching: false)
        follow.host(watching: true)
        XCTAssertTrue(follow.follows(frontmost: openWork, host: openWork, target: app))
    }

    func testAWindowThePersonMovedOrTheAgentArrangedStaysWhereItIs() {
        var follow = FollowAlong(watching: true)
        XCTAssertTrue(follow.arrangeNow(current: CGRect(x: 0, y: 0, width: 500, height: 400), arranged: nil))
        follow.host(watching: false); follow.host(watching: true)
        let resized = CGRect(x: 720, y: 25, width: 600, height: 875)
        XCTAssertFalse(follow.arrangeNow(current: resized, arranged: beside), "the person resized it")
        follow.host(watching: false); follow.host(watching: true)
        XCTAssertFalse(follow.arrangeNow(current: beside, arranged: beside), "for the rest of the session")

        var agent = FollowAlong(watching: true)
        agent.agentPlaced()
        agent.host(watching: false); agent.host(watching: true)
        XCTAssertFalse(agent.arrangeNow(current: nil, arranged: nil))
    }

    func testSeveralAppsInAChatFollowWithoutGoingBesideOpenWork() {
        var follow = FollowAlong(watching: true, beside: false)
        XCTAssertTrue(follow.follows(frontmost: openWork, host: openWork, target: app))
        XCTAssertFalse(follow.arrangeNow(current: nil, arranged: nil))
        follow.host(watching: false); follow.host(watching: true, beside: true)
        XCTAssertTrue(follow.arrangeNow(current: nil, arranged: nil))
    }

    func testWatchingWhileTypingInTheComposerKeepsTheWindowBesideAndGivesTheKeysBack() {
        var follow = FollowAlong(watching: true)
        XCTAssertTrue(follow.follows(frontmost: openWork, host: openWork, target: app))
        XCTAssertTrue(follow.arrangeNow(current: CGRect(x: 0, y: 0, width: 500, height: 400), arranged: nil))
        // The person was writing in the composer during the wait: the step takes the front
        // from OpenWork, and the composer gets it back at once when the step ends.
        var handBack = SharedDesktop.HandBack()
        handBack.beginMoment()
        handBack.record(frontmost: openWork, target: app, own: 1, host: openWork, at: 10, typing: true, inField: true)
        XCTAssertTrue(handBack.eachMoment)
        XCTAssertTrue(handBack.immediate, "keys go back to the composer right after the step")
        XCTAssertEqual(handBack.take(frontmost: app, target: app, lastKey: 9, lastClick: 9), openWork)
        // Back in the composer is still watching: the window stays beside OpenWork, not moved again.
        XCTAssertTrue(follow.follows(frontmost: openWork, host: openWork, target: app))
        XCTAssertFalse(follow.arrangeNow(current: beside, arranged: beside))
        // The next step still works in front while they watch.
        handBack.beginMoment()
        handBack.record(frontmost: openWork, target: app, own: 1, host: openWork, at: 20, typing: true, inField: true)
        XCTAssertEqual(handBack.take(frontmost: app, target: app, lastKey: 19, lastClick: 19), openWork)
    }

    func testTheFrontTakenFromOpenWorkGoesBackWhenThePersonIsInAnotherChat() {
        // Following: the first take from OpenWork keeps the front with the agent (#6954).
        var following = SharedDesktop.HandBack()
        following.record(frontmost: openWork, target: app, own: 1, host: openWork, at: 0)
        XCTAssertFalse(following.eachMoment)
        // Not following, the host is passed as no app: OpenWork gets the front back after the step.
        var elsewhere = SharedDesktop.HandBack()
        elsewhere.record(frontmost: openWork, target: app, own: 1, host: 0, at: 0)
        XCTAssertTrue(elsewhere.eachMoment)
    }
}
