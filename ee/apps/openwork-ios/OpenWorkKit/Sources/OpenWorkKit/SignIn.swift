import CryptoKit
import Foundation
import Security

/// Which server the app talks to.
public struct ServerConfiguration: Sendable, Equatable {
    /// The Workbot server, for example `https://chat.openworklabs.com`.
    public let baseURL: URL

    /// Where sign-in returns: a page on the server that iOS opens only in this app.
    public static let callbackPath = "/auth/app/callback"

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    public var callbackHost: String {
        baseURL.host() ?? ""
    }

    public var redirectURI: String {
        origin + Self.callbackPath
    }

    public func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(string: origin + path) ?? URLComponents()
        if !query.isEmpty {
            components.queryItems = query
        }
        return components.url ?? baseURL
    }

    private var origin: String {
        var text = baseURL.absoluteString
        while text.hasSuffix("/") {
            text.removeLast()
        }
        return text
    }
}

/// One sign-in in progress. The verifier never leaves the app until the code is traded for a session.
public struct SignInAttempt: Sendable, Equatable {
    public let verifier: String
    public let state: String
    public let loginURL: URL
}

public enum SignInFailure: Error, Equatable, Sendable {
    /// The answer did not belong to the sign-in this app started.
    case stateMismatch
    /// OpenWork refused, or the person declined.
    case refused
    case missingCode
}

public enum SignIn {
    /// Starts a sign-in: a fresh verifier and state, and the page to open in the system's sign-in sheet.
    public static func begin(server: ServerConfiguration, randomBytes: (Int) -> [UInt8] = secureRandomBytes) -> SignInAttempt {
        let verifier = base64URL(randomBytes(32))
        let state = base64URL(randomBytes(24))
        let loginURL = server.url("/auth/app/login", query: [
            URLQueryItem(name: "code_challenge", value: challenge(for: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "redirect_uri", value: server.redirectURI),
        ])
        return SignInAttempt(verifier: verifier, state: state, loginURL: loginURL)
    }

    /// The PKCE challenge for a verifier (S256).
    public static func challenge(for verifier: String) -> String {
        base64URL(Array(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// The code in the address sign-in returned to, once it is known to answer this attempt.
    public static func code(from callback: URL, for attempt: SignInAttempt) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard value("state") == attempt.state else { throw SignInFailure.stateMismatch }
        if value("error") != nil {
            throw SignInFailure.refused
        }
        guard let code = value("code"), !code.isEmpty else { throw SignInFailure.missingCode }
        return code
    }

    public static func secureRandomBytes(_ count: Int) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: count)
        if SecRandomCopyBytes(kSecRandomDefault, count, &bytes) != errSecSuccess {
            var generator = SystemRandomNumberGenerator()
            bytes = (0 ..< count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        }
        return bytes
    }

    static func base64URL(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// An id for a new message, in the shape the server accepts.
public enum MessageID {
    public static func make() -> String {
        SignIn.base64URL(SignIn.secureRandomBytes(16))
    }
}
