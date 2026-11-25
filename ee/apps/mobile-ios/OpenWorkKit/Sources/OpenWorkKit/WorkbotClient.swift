import Foundation

/// Why a request did not work, in the terms the screens need.
public enum APIFailure: Error, Equatable, Sendable {
    /// The session is gone or was refused: sign in again.
    case signedOut
    /// The workspace has not turned Workbot on for phones.
    case phoneNotEnabled
    /// This phone has no connection.
    case offline
    /// The server, or OpenWork behind it, cannot answer right now.
    case unavailable
    case refused(status: Int, code: String?, message: String?)
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    /// Opens a response and reads it line by line as it arrives.
    func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = URLSessionTransport.makeSession()) {
        self.session = session
    }

    /// No cookies and no cache: the session travels only in the request header.
    public static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    public func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        let stream = AsyncThrowingStream<String, Error> { continuation in
            let reading = Task {
                do {
                    for try await line in bytes.lines {
                        continuation.yield(line)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reading.cancel() }
        }
        return (stream, http)
    }
}

/// The Workbot server, as the phone uses it: the same routes the web page uses, with the phone's session.
public actor WorkbotClient {
    private let server: ServerConfiguration
    private let store: any SessionStoring
    private let transport: any HTTPTransport
    private let now: @Sendable () -> Date
    private var renewal: Task<AppSession, Error>?

    /// Renew this long before the session's tokens run out.
    private static let renewalMargin: TimeInterval = 5 * 60

    public init(
        server: ServerConfiguration,
        store: any SessionStoring,
        transport: any HTTPTransport = URLSessionTransport(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.server = server
        self.store = store
        self.transport = transport
        self.now = now
    }

    public nonisolated var isSignedIn: Bool {
        store.load() != nil
    }

    // MARK: Sign-in

    /// Trades the code sign-in returned for the phone's session, with the verifier only this app has.
    public func exchange(code: String, attempt: SignInAttempt) async throws {
        var request = URLRequest(url: server.url("/auth/app/token"))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["code": code, "codeVerifier": attempt.verifier, "redirectUri": server.redirectURI])
        let (data, response) = try await perform(request)
        guard response.statusCode == 200, let session = try? JSONDecoder().decode(AppSession.self, from: data) else {
            throw failure(status: response.statusCode, data: data)
        }
        store.save(session)
    }

    /// Ends the session on the server when it can, and always on this phone.
    public func signOut() async {
        if let session = store.load() {
            var request = URLRequest(url: server.url("/auth/logout"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
            _ = try? await perform(request)
        }
        store.clear()
    }

    // MARK: Workbot

    public func me() async throws -> Me {
        try await decode(Me.self, from: authorized("GET", "/v1/workbot/me"))
    }

    public func conversation(turns: Int = 30) async throws -> Conversation {
        try await decode(Conversation.self, from: authorized("GET", "/v1/workbot", query: [URLQueryItem(name: "turns", value: String(turns))]))
    }

    public func send(id: String, text: String, timeZone: String = TimeZone.current.identifier) async throws {
        _ = try await authorized("POST", "/v1/workbot/messages", json: ["id": id, "text": text, "timeZone": timeZone])
    }

    /// Answers a message whose answer failed, in place.
    public func retry(id: String, timeZone: String = TimeZone.current.identifier) async throws {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await authorized("POST", "/v1/workbot/messages/\(escaped)/retry", json: ["timeZone": timeZone])
    }

    public func stop() async throws {
        _ = try await authorized("POST", "/v1/workbot/stop")
    }

    /// Live events while Workbot answers. The server ends the stream every few minutes; open it again.
    public func events() async throws -> AsyncThrowingStream<LiveEvent, Error> {
        var request = try await authorizedRequest("GET", "/v1/workbot/events")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 200
        let lines: AsyncThrowingStream<String, Error>
        let response: HTTPURLResponse
        do {
            (lines, response) = try await transport.lines(request)
        } catch {
            throw Self.networkFailure(error)
        }
        adoptRenewal(from: response)
        guard response.statusCode == 200 else {
            if response.statusCode == 401 {
                store.clear()
            }
            throw failure(status: response.statusCode, data: Data())
        }
        return AsyncThrowingStream { continuation in
            let reading = Task {
                var reader = ServerSentEventReader()
                let decoder = JSONDecoder()
                do {
                    for try await line in lines {
                        guard let message = reader.read(line: line), message.event != "ready" else { continue }
                        if let event = try? decoder.decode(LiveEvent.self, from: Data(message.data.utf8)) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reading.cancel() }
        }
    }

    // MARK: Requests

    private func authorized(_ method: String, _ path: String, query: [URLQueryItem] = [], json: [String: String]? = nil) async throws -> Data {
        var request = try await authorizedRequest(method, path, query: query)
        if let json {
            request.httpBody = try JSONEncoder().encode(json)
        }
        let (data, response) = try await perform(request)
        adoptRenewal(from: response)
        guard (200 ..< 300).contains(response.statusCode) else {
            if response.statusCode == 401 {
                store.clear()
            }
            throw failure(status: response.statusCode, data: data)
        }
        return data
    }

    private func authorizedRequest(_ method: String, _ path: String, query: [URLQueryItem] = []) async throws -> URLRequest {
        let session = try await freshSession()
        var request = URLRequest(url: server.url(path, query: query))
        request.httpMethod = method
        request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var request = request
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if request.httpBody != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if request.timeoutInterval == 60 {
            request.timeoutInterval = 30
        }
        do {
            return try await transport.send(request)
        } catch {
            throw Self.networkFailure(error)
        }
    }

    /// The session to send. It is renewed first when its tokens are about to run out, once for all waiting requests.
    private func freshSession() async throws -> AppSession {
        guard let session = store.load() else { throw APIFailure.signedOut }
        let remaining = session.expiresAt / 1000 - now().timeIntervalSince1970
        if remaining > Self.renewalMargin {
            return session
        }
        if let renewal {
            return try await renewal.value
        }
        let task = Task { try await self.renew(session) }
        renewal = task
        defer { renewal = nil }
        do {
            return try await task.value
        } catch APIFailure.signedOut {
            throw APIFailure.signedOut
        } catch {
            // The server renews on its own while the old session still works; only an expired one is stuck.
            if remaining > 0 {
                return session
            }
            throw error
        }
    }

    private func renew(_ session: AppSession) async throws -> AppSession {
        var request = URLRequest(url: server.url("/auth/app/refresh"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await perform(request)
        guard response.statusCode == 200, let renewed = try? JSONDecoder().decode(AppSession.self, from: data) else {
            if response.statusCode == 401 {
                store.clear()
            }
            throw failure(status: response.statusCode, data: data)
        }
        store.save(renewed)
        return renewed
    }

    /// When the server had to renew the session's tokens itself, the answer carries the replacement.
    private func adoptRenewal(from response: HTTPURLResponse) {
        guard let token = response.value(forHTTPHeaderField: "Workbot-Session"), !token.isEmpty,
              let expires = response.value(forHTTPHeaderField: "Workbot-Session-Expires").flatMap(Double.init)
        else { return }
        store.save(AppSession(token: token, expiresAt: expires))
    }

    private func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIFailure.unavailable
        }
    }

    private struct ErrorBody: Decodable {
        let error: String?
        let message: String?
    }

    private func failure(status: Int, data: Data) -> APIFailure {
        let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
        if status == 401 {
            return .signedOut
        }
        if body?.error == "workbot_mobile_not_enabled" {
            return .phoneNotEnabled
        }
        if status >= 500 || body?.error == "den_unavailable" {
            return .unavailable
        }
        return .refused(status: status, code: body?.error, message: body?.message)
    }

    private static func networkFailure(_ error: any Error) -> any Error {
        if error is CancellationError {
            return error
        }
        guard let url = error as? URLError else { return APIFailure.unavailable }
        switch url.code {
        case .cancelled: return CancellationError()
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff: return APIFailure.offline
        default: return APIFailure.unavailable
        }
    }
}
