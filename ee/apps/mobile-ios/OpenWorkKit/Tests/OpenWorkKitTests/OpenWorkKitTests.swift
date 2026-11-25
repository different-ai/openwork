import Foundation
@testable import OpenWorkKit
import Testing

private let server = ServerConfiguration(baseURL: URL(string: "https://workbot.test")!)

/// A stand-in server: answers each request from a table and remembers what was asked.
private final class FakeServer: HTTPTransport, @unchecked Sendable {
    struct Answer {
        var status = 200
        var headers: [String: String] = [:]
        var json = "{}"
    }

    private let lock = NSLock()
    private var answers: [String: [Answer]] = [:]
    private var seen: [URLRequest] = []
    private var failure: URLError?
    private var eventLines: [String] = []

    func answer(_ method: String, _ path: String, _ answer: Answer) {
        lock.withLock { answers["\(method) \(path)", default: []].append(answer) }
    }

    func answer(_ method: String, _ path: String, status: Int = 200, json: String = "{}") {
        answer(method, path, Answer(status: status, json: json))
    }

    func failEverything(_ code: URLError.Code?) {
        lock.withLock { failure = code.map { URLError($0) } }
    }

    func streamEvents(_ lines: [String]) {
        lock.withLock { eventLines = lines }
    }

    var requests: [URLRequest] {
        lock.withLock { seen }
    }

    func requests(to path: String) -> [URLRequest] {
        requests.filter { $0.url?.path == path }
    }

    private func next(_ request: URLRequest) throws -> (Answer, HTTPURLResponse) {
        try lock.withLock {
            seen.append(request)
            if let failure {
                throw failure
            }
            let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
            var queue = answers[key] ?? []
            // The last answer for a route repeats, so a test only lists what changes.
            let answer = queue.count > 1 ? queue.removeFirst() : (queue.first ?? Answer(status: 404, json: #"{"error":"not_found"}"#))
            if answers[key] != nil {
                answers[key] = queue
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: nil, headerFields: answer.headers)!
            return (answer, response)
        }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (answer, response) = try next(request)
        return (Data(answer.json.utf8), response)
    }

    func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let (_, response) = try next(request)
        let lines = lock.withLock { eventLines }
        return (AsyncThrowingStream { continuation in
            for line in lines {
                continuation.yield(line)
            }
            continuation.finish()
        }, response)
    }
}

private final class Consent: ConsentStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var agreed = Set<String>()
    func hasAgreed(userId: String) -> Bool {
        lock.withLock { agreed.contains(userId) }
    }

    func recordAgreement(userId: String) {
        lock.withLock { _ = agreed.insert(userId) }
    }
}

private let farFuture = Date(timeIntervalSince1970: 2_000_000_000).timeIntervalSince1970 * 1000
private let clock: @Sendable () -> Date = { Date(timeIntervalSince1970: 1_000_000_000) }

private func signedIn(_ fake: FakeServer, expiresAt: Double = farFuture) -> (WorkbotClient, MemorySessionStore) {
    let store = MemorySessionStore(AppSession(token: "session-1", expiresAt: expiresAt))
    return (WorkbotClient(server: server, store: store, transport: fake, now: clock), store)
}

private func me(mobile: Bool = true, enabled: Bool = true) -> String {
    #"{"userId":"user_1","organizationId":"org_1","name":"Ada Park","email":"ada@example.test","organizationName":"Example Co","enabled":\#(enabled),"mobile":\#(mobile),"calendar":true}"#
}

private func thread(_ turns: String, status: String = "idle") -> String {
    #"{"available":true,"name":"Workbot","organizationName":"Example Co","status":"\#(status)","turns":[\#(turns)],"hasEarlier":false,"filesEnabled":true}"#
}

private func turn(_ id: String, _ text: String, status: String = "done", answer: String = "") -> String {
    #"{"id":"\#(id)","text":"\#(text)","sentAt":1,"finishedAt":2,"status":"\#(status)","attachments":[],"parts":[{"kind":"text","text":"\#(answer)","step":0}],"modelSteps":1,"error":null}"#
}

// MARK: Sign-in

struct SignInTests {
    @Test func challengeMatchesThePublishedExample() {
        // RFC 7636, appendix B.
        #expect(SignIn.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func startsASignInTheServerAccepts() throws {
        let attempt = SignIn.begin(server: server)
        let items = try #require(URLComponents(url: attempt.loginURL, resolvingAgainstBaseURL: false)?.queryItems)
        let value = { (name: String) in items.first { $0.name == name }?.value }

        #expect(attempt.loginURL.absoluteString.hasPrefix("https://workbot.test/auth/app/login?"))
        #expect(value("code_challenge") == SignIn.challenge(for: attempt.verifier))
        #expect(value("code_challenge_method") == "S256")
        #expect(value("redirect_uri") == "https://workbot.test/auth/app/callback")
        #expect(value("state") == attempt.state)
        // The shapes the server checks.
        #expect(attempt.verifier.wholeMatch(of: /[A-Za-z0-9._~-]{43,128}/) != nil)
        #expect(attempt.state.wholeMatch(of: /[A-Za-z0-9_-]{16,200}/) != nil)
        #expect(SignIn.begin(server: server).verifier != attempt.verifier)
    }

    @Test func takesTheCodeOnlyFromItsOwnSignIn() throws {
        let attempt = SignIn.begin(server: server)
        let back = { (query: String) in URL(string: "https://workbot.test/auth/app/callback?\(query)")! }

        #expect(try SignIn.code(from: back("code=abc&state=\(attempt.state)"), for: attempt) == "abc")
        #expect(throws: SignInFailure.stateMismatch) { try SignIn.code(from: back("code=abc&state=someone-else"), for: attempt) }
        #expect(throws: SignInFailure.refused) { try SignIn.code(from: back("error=access_denied&state=\(attempt.state)"), for: attempt) }
        #expect(throws: SignInFailure.missingCode) { try SignIn.code(from: back("state=\(attempt.state)"), for: attempt) }
    }
}

// MARK: Live answers

struct LiveTests {
    @Test func readsEventsLineByLine() {
        var reader = ServerSentEventReader()
        let lines = ["event: ready", "data: {}", "", ": keep-alive", #"data: {"type":"changed","messageId":"m1"}"#]
        let events = lines.compactMap { reader.read(line: $0) }

        #expect(events == [
            ServerSentEvent(event: "ready", data: "{}"),
            ServerSentEvent(event: nil, data: #"{"type":"changed","messageId":"m1"}"#),
        ])
    }

    @Test func buildsAnAnswerFromItsPieces() {
        var live = LiveAnswers()

        #expect(live.apply(.text(messageId: "m1", step: 0, delta: "Hel", reset: false)) == false)
        live.apply(.text(messageId: "m1", step: 0, delta: "lo", reset: false))
        #expect(live["m1"]?.display == "Hello")

        // A reset replaces what this model call wrote.
        live.apply(.text(messageId: "m1", step: 0, delta: "Hi", reset: true))
        #expect(live["m1"]?.display == "Hi")

        // The next model call starts fresh; the earlier words stay above it.
        live.apply(.working(messageId: "m1", step: 1))
        #expect(live["m1"]?.working == true)
        live.apply(.text(messageId: "m1", step: 1, delta: "Done.", reset: false))
        #expect(live["m1"]?.display == "Hi\n\nDone.")

        // Late pieces of an earlier call change nothing.
        live.apply(.text(messageId: "m1", step: 0, delta: "late", reset: false))
        #expect(live["m1"]?.display == "Hi\n\nDone.")

        #expect(live.apply(.changed(messageId: "m1")) == true)
    }

    @Test func dropsLiveTextOnceTheAnswerIsStored() {
        var live = LiveAnswers()
        live.apply(.text(messageId: "done", step: 0, delta: "a", reset: false))
        live.apply(.text(messageId: "working", step: 0, delta: "b", reset: false))

        live.settle(with: [Turn(id: "done", text: "", status: .done), Turn(id: "working", text: "", status: .working)])

        #expect(live["done"] == nil)
        #expect(live["working"]?.text == "b")
    }

    @Test func decodesLiveEvents() throws {
        let decode = { (json: String) in try JSONDecoder().decode(LiveEvent.self, from: Data(json.utf8)) }

        #expect(try decode(#"{"type":"text","messageId":"m","step":2,"delta":"x"}"#) == .text(messageId: "m", step: 2, delta: "x", reset: false))
        #expect(try decode(#"{"type":"working","messageId":"m","step":2,"on":"computer"}"#) == .working(messageId: "m", step: 2))
        #expect(throws: (any Error).self) { try decode(#"{"type":"new-thing","messageId":"m"}"#) }
    }
}

// MARK: The conversation as stored

struct ConversationTests {
    @Test func readsAConversationAndSkipsWhatItCannotDraw() throws {
        let json = thread(#"""
        {"id":"m1","text":"What's next?","sentAt":10,"status":"done","attachments":[{"id":"f1","name":"notes.pdf","mediaType":"application/pdf","size":3}],
         "parts":[{"kind":"steps","steps":[{"label":"Gmail","icon":"app","status":"done","app":"gmail"},{"label":"Gmail","icon":"app","status":"done","app":"gmail"},{"label":"Calendar","icon":"app","status":"done","app":null}]},
                  {"kind":"text","text":"Two meetings.","step":0},{"kind":"hologram","payload":1},{"kind":"text","text":"Then lunch.","step":1}],
         "modelSteps":2,"error":null,"modelIssue":"free_limit","tasks":[{"id":"t1","title":"Draft the report","status":"working"}]}
        """#, status: "busy")
        let conversation = try JSONDecoder().decode(Conversation.self, from: Data(json.utf8))
        guard case let .available(turns, busy, hasEarlier) = conversation else {
            Issue.record("expected a conversation")
            return
        }
        let first = try #require(turns.first)

        #expect(busy == true)
        #expect(hasEarlier == false)
        #expect(first.answerText == "Two meetings.\n\nThen lunch.")
        #expect(first.workLabels == ["Gmail", "Calendar"])
        #expect(first.modelIssue == .freeLimit)
        #expect(first.retryable == true)
        #expect(first.attachments.map(\.name) == ["notes.pdf"])
        #expect(first.tasks.first?.isRunning == true)
    }

    @Test func readsWhyThereIsNoConversation() throws {
        let decode = { (json: String) in try JSONDecoder().decode(Conversation.self, from: Data(json.utf8)) }

        #expect(try decode(#"{"available":false,"reason":"workbot_not_enabled"}"#) == .unavailable(.notEnabled))
        #expect(try decode(#"{"available":false,"reason":"something_new"}"#) == .unavailable(.runnerUnavailable))
    }

    @Test func aServerThatDoesNotMentionPhonesDoesNotAllowThem() throws {
        let old = #"{"userId":"u","organizationId":"o","name":"A","email":"a@example.test","organizationName":"O","enabled":true}"#

        #expect(try JSONDecoder().decode(Me.self, from: Data(old.utf8)).mobile == false)
        #expect(try JSONDecoder().decode(Me.self, from: Data(me().utf8)).mobile == true)
    }
}

// MARK: Answers as text

struct MarkdownTests {
    @Test func splitsAnAnswerIntoBlocks() {
        let blocks = Markdown.blocks("""
        # Plan

        First line
        second line

        - one
          - nested
        2. two
        > quoted
        ---
        ```swift
        let x = 1

        ```
        """)

        #expect(blocks == [
            .heading(level: 1, text: "Plan"),
            .paragraph("First line\nsecond line"),
            .bullet(text: "one", depth: 0),
            .bullet(text: "nested", depth: 1),
            .numbered(marker: "2.", text: "two", depth: 0),
            .quote("quoted"),
            .rule,
            .code("let x = 1\n"),
        ])
    }

    @Test func showsACodeBlockThatIsStillStreaming() {
        #expect(Markdown.blocks("Here:\n```\nline one") == [.paragraph("Here:"), .code("line one")])
    }

    @Test func keepsOnlyWebAndMailLinks() {
        let styled = Markdown.inline("[site](https://example.test) [mail](mailto:a@example.test) [bad](javascript:alert(1)) [file](file:///etc/passwd)")
        let links = styled.runs.compactMap(\.link).map(\.absoluteString)

        #expect(links == ["https://example.test", "mailto:a@example.test"])
        #expect(String(styled.characters) == "site mail bad file")
    }
}

// MARK: Talking to the server

struct ClientTests {
    @Test func sendsTheSessionAndKeepsTheOneTheServerReplacesItWith() async throws {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot/me", .init(headers: ["Workbot-Session": "session-2", "Workbot-Session-Expires": "\(farFuture + 1)"], json: me()))
        let (client, store) = signedIn(fake)

        let who = try await client.me()

        #expect(who.name == "Ada Park")
        #expect(fake.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer session-1")
        #expect(store.load() == AppSession(token: "session-2", expiresAt: farFuture + 1))
    }

    @Test func renewsASessionThatIsAboutToRunOut() async throws {
        let fake = FakeServer()
        fake.answer("POST", "/auth/app/refresh", json: #"{"session":"session-2","expiresAt":\#(farFuture)}"#)
        fake.answer("GET", "/v1/workbot/me", json: me())
        let soon = (clock().timeIntervalSince1970 + 60) * 1000
        let (client, store) = signedIn(fake, expiresAt: soon)

        _ = try await client.me()

        #expect(fake.requests.map { $0.url?.path } == ["/auth/app/refresh", "/v1/workbot/me"])
        #expect(fake.requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer session-2")
        #expect(store.load()?.token == "session-2")
    }

    @Test func aRefusedSessionSignsThePhoneOut() async {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot/me", status: 401, json: #"{"error":"signed_out"}"#)
        let (client, store) = signedIn(fake)

        await #expect(throws: APIFailure.signedOut) { try await client.me() }
        #expect(store.load() == nil)
    }

    @Test func saysWhyARequestDidNotWork() async {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot", status: 403, json: #"{"error":"workbot_mobile_not_enabled"}"#)
        fake.answer("POST", "/v1/workbot/messages", status: 429, json: #"{"error":"rate_limited","retryAfter":20}"#)
        fake.answer("POST", "/v1/workbot/stop", status: 503, json: #"{"error":"den_unavailable"}"#)
        let (client, _) = signedIn(fake)

        await #expect(throws: APIFailure.phoneNotEnabled) { try await client.conversation() }
        await #expect(throws: APIFailure.refused(status: 429, code: "rate_limited", message: nil)) { try await client.send(id: "abcdefgh", text: "hi") }
        await #expect(throws: APIFailure.unavailable) { try await client.stop() }

        fake.failEverything(.notConnectedToInternet)
        await #expect(throws: APIFailure.offline) { try await client.me() }
    }

    @Test func sendsAMessageTheWayTheServerExpects() async throws {
        let fake = FakeServer()
        fake.answer("POST", "/v1/workbot/messages", status: 202, json: #"{"ok":true}"#)
        let (client, _) = signedIn(fake)

        try await client.send(id: "abcdefgh", text: "Hello", timeZone: "America/Los_Angeles")

        let request = try #require(fake.requests.first)
        let body = try JSONDecoder().decode([String: String].self, from: #require(request.httpBody))
        #expect(body == ["id": "abcdefgh", "text": "Hello", "timeZone": "America/Los_Angeles"])
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(MessageID.make().wholeMatch(of: /[A-Za-z0-9_-]{8,64}/) != nil)
    }

    @Test func readsLiveEventsFromTheStream() async throws {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot/events", .init())
        fake.streamEvents([
            "event: ready",
            "data: {}",
            "",
            #"data: {"type":"text","messageId":"m1","step":0,"delta":"Hi"}"#,
            "",
            "data: not json",
            #"data: {"type":"changed","messageId":"m1"}"#,
        ])
        let (client, _) = signedIn(fake)

        var events: [LiveEvent] = []
        for try await event in try await client.events() {
            events.append(event)
        }

        #expect(events == [.text(messageId: "m1", step: 0, delta: "Hi", reset: false), .changed(messageId: "m1")])
        #expect(fake.requests.first?.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    }
}

// MARK: Where the app is

@MainActor
struct AppModelTests {
    private func app(_ fake: FakeServer, signedIn: Bool, consent: Consent = Consent()) -> (AppModel, MemorySessionStore) {
        let store = MemorySessionStore(signedIn ? AppSession(token: "session-1", expiresAt: farFuture) : nil)
        let client = WorkbotClient(server: server, store: store, transport: fake, now: clock)
        return (AppModel(server: server, client: client, consent: consent), store)
    }

    @Test func startsSignedOutWithoutASession() async {
        let (model, _) = app(FakeServer(), signedIn: false)
        await model.start()
        #expect(model.phase == .signedOut)
    }

    @Test func signsInThenAsksForConsentBeforeTheConversation() async throws {
        let fake = FakeServer()
        fake.answer("POST", "/auth/app/token", json: #"{"session":"session-9","expiresAt":\#(farFuture)}"#)
        fake.answer("GET", "/v1/workbot/me", json: me())
        let (model, store) = app(fake, signedIn: false)
        await model.start()

        let attempt = model.beginSignIn()
        try await model.completeSignIn(callback: #require(URL(string: "https://workbot.test/auth/app/callback?code=the-code&state=\(attempt.state)")))

        let sent = try JSONDecoder().decode([String: String].self, from: #require(fake.requests(to: "/auth/app/token").first?.httpBody))
        #expect(sent == ["code": "the-code", "codeVerifier": attempt.verifier, "redirectUri": "https://workbot.test/auth/app/callback"])
        #expect(store.load()?.token == "session-9")
        #expect(model.phase == .consent)

        model.agreeToAIUse()
        #expect(model.phase == .chat)
    }

    @Test func saysWhenTheWorkspaceHasNotTurnedPhonesOn() async throws {
        let fake = FakeServer()
        fake.answer("POST", "/auth/app/token", status: 403, json: #"{"error":"workbot_mobile_not_enabled"}"#)
        let (model, store) = app(fake, signedIn: false)
        await model.start()

        let attempt = model.beginSignIn()
        try await model.completeSignIn(callback: #require(URL(string: "https://workbot.test/auth/app/callback?code=the-code&state=\(attempt.state)")))

        #expect(model.signInProblem == .phoneOff)
        #expect(model.phase == .signedOut)
        #expect(store.load() == nil)
    }

    @Test func anAnswerToSomeoneElsesSignInIsRefused() async throws {
        let fake = FakeServer()
        let (model, store) = app(fake, signedIn: false)
        await model.start()

        _ = model.beginSignIn()
        try await model.completeSignIn(callback: #require(URL(string: "https://workbot.test/auth/app/callback?code=stolen&state=not-ours")))

        #expect(model.signInProblem == .failed)
        #expect(fake.requests.isEmpty)
        #expect(store.load() == nil)
        #expect(model.phase == .signedOut)
    }

    @Test func closingTheSignInSheetIsNotAnError() async {
        let (model, _) = app(FakeServer(), signedIn: false)
        await model.start()
        _ = model.beginSignIn()

        model.signInEnded(cancelled: true)
        #expect(model.signInProblem == nil)
    }

    @Test func staysLockedUntilTheWorkspaceAllowsPhones() async {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot/me", json: me(mobile: false))
        let (model, _) = app(fake, signedIn: true)

        await model.start()
        #expect(model.phase == .locked(.phoneOff))

        // Where Workbot itself is off, the server reports phones as off too: say the real reason.
        fake.answer("GET", "/v1/workbot/me", json: me(mobile: false, enabled: false))
        await model.readProfile()
        #expect(model.phase == .locked(.phoneOff))
        await model.readProfile()
        #expect(model.phase == .locked(.workbotOff))
    }

    @Test func remembersConsentPerAccountAndSignsOut() async {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot/me", json: me())
        fake.answer("POST", "/auth/logout", json: #"{"ok":true}"#)
        let consent = Consent()
        consent.recordAgreement(userId: "user_1")
        let (model, store) = app(fake, signedIn: true, consent: consent)

        await model.start()
        #expect(model.phase == .chat)
        #expect(model.me?.organizationName == "Example Co")

        await model.signOut()
        #expect(model.phase == .signedOut)
        #expect(store.load() == nil)
        #expect(fake.requests(to: "/auth/logout").first?.value(forHTTPHeaderField: "Authorization") == "Bearer session-1")
    }

    @Test func saysWhenOpenWorkCannotBeReached() async {
        let fake = FakeServer()
        fake.failEverything(.notConnectedToInternet)
        let (model, store) = app(fake, signedIn: true)

        await model.start()

        #expect(model.phase == .unreachable(offline: true))
        // An outage is not a sign-out.
        #expect(store.load() != nil)
    }
}

// MARK: The conversation on screen

@MainActor
struct ChatModelTests {
    private func chat(_ fake: FakeServer) -> ChatModel {
        ChatModel(client: signedIn(fake).0, pause: { _ in })
    }

    @Test func showsASentMessageAtOnceThenTheStoredOne() async throws {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot", json: thread(turn("m0", "Earlier", answer: "Yes.")))
        fake.answer("POST", "/v1/workbot/messages", status: 202, json: #"{"ok":true}"#)
        let model = chat(fake)
        await model.load()
        #expect(model.turns.map(\.id) == ["m0"])

        await model.send("  What's next?  ")

        let sent = try #require(model.turns.last)
        #expect(sent.text == "What's next?")
        #expect(model.isBusy)

        // The server now lists it: one copy, the stored one.
        fake.answer("GET", "/v1/workbot", json: thread(turn("m0", "Earlier", answer: "Yes.") + "," + turn(sent.id, "What's next?", answer: "Lunch.")))
        await model.load()
        await model.load()
        #expect(model.turns.map(\.id) == ["m0", sent.id])
        #expect(model.turns.last?.answerText == "Lunch.")
        #expect(model.isBusy == false)
    }

    @Test func keepsAMessageThatDidNotSendAndSendsItAgainAsTheSameMessage() async throws {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot", json: thread(""))
        fake.answer("POST", "/v1/workbot/messages", status: 429, json: #"{"error":"rate_limited","retryAfter":20}"#)
        fake.answer("POST", "/v1/workbot/messages", status: 202, json: #"{"ok":true}"#)
        let model = chat(fake)
        await model.load()

        await model.send("Hello")
        let failed = try #require(model.turns.last)
        #expect(failed.status == .failed)
        #expect(model.sendProblems[failed.id] == .sendingTooFast)

        await model.sendAgain(failed)
        #expect(model.sendProblems[failed.id] == nil)
        #expect(model.turns.last?.status == .queued)
        let ids = try fake.requests(to: "/v1/workbot/messages").map { try JSONDecoder().decode([String: String].self, from: #require($0.httpBody))["id"] }
        #expect(ids == [failed.id, failed.id])
    }

    @Test func saysWhyThereIsNoConversationAndWhenItCannotLoad() async {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot", json: #"{"available":false,"reason":"workbot_model_unavailable"}"#)
        let model = chat(fake)

        await model.load()
        #expect(model.state == .unavailable(.modelUnavailable))

        fake.failEverything(.notConnectedToInternet)
        let offline = chat(fake)
        await offline.load()
        #expect(offline.state == .failed(offline: true))
    }

    @Test func keepsTheConversationOnScreenThroughABlip() async {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot", json: thread(turn("m0", "Earlier", answer: "Yes.")))
        let model = chat(fake)
        await model.load()

        fake.failEverything(.timedOut)
        await model.load()

        #expect(model.state == .ready)
        #expect(model.connectionLost)
        #expect(model.turns.count == 1)

        fake.failEverything(nil)
        await model.load()
        #expect(model.connectionLost == false)
    }

    @Test func tellsTheAppWhenTheSessionIsGone() async {
        let fake = FakeServer()
        fake.answer("GET", "/v1/workbot", status: 401, json: #"{"error":"signed_out"}"#)
        let model = chat(fake)
        var signedOut = false
        model.onSignedOut = { signedOut = true }

        await model.load()

        #expect(signedOut)
    }
}
