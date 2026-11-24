import Foundation
import Security

/// What the phone keeps after signing in: a session only the Workbot server can read, and when to renew it.
/// It is not an OpenWork token and opens nothing but Workbot.
public struct AppSession: Codable, Sendable, Equatable {
    public var token: String
    /// Milliseconds since 1970.
    public var expiresAt: Double

    public init(token: String, expiresAt: Double) {
        self.token = token
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case token = "session"
        case expiresAt
    }
}

public protocol SessionStoring: Sendable {
    func load() -> AppSession?
    func save(_ session: AppSession)
    func clear()
}

/// Keeps the session in the Keychain, on this device only.
public struct KeychainSessionStore: SessionStoring {
    private let service: String
    private let account = "workbot-session"

    public init(service: String) {
        self.service = service
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() -> AppSession? {
        var item: CFTypeRef?
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(AppSession.self, from: data)
    }

    public func save(_ session: AppSession) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard update == errSecItemNotFound else { return }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

/// Keeps the session in memory: tests, previews, and development runs against a local stand-in server.
public final class MemorySessionStore: SessionStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var session: AppSession?

    public init(_ session: AppSession? = nil) {
        self.session = session
    }

    public func load() -> AppSession? {
        lock.withLock { session }
    }

    public func save(_ session: AppSession) {
        lock.withLock { self.session = session }
    }

    public func clear() {
        lock.withLock { session = nil }
    }
}

/// Remembers that a person agreed to how Workbot uses AI providers, per account, on this device.
public protocol ConsentStoring: Sendable {
    func hasAgreed(userId: String) -> Bool
    func recordAgreement(userId: String)
}

public struct DefaultsConsentStore: ConsentStoring, @unchecked Sendable {
    private let defaults: UserDefaults
    /// Raise this when what the consent screen says changes, so people are asked again.
    public static let version = 1

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(_ userId: String) -> String {
        "ai-consent-v\(Self.version)-\(userId)"
    }

    public func hasAgreed(userId: String) -> Bool {
        defaults.bool(forKey: key(userId))
    }

    public func recordAgreement(userId: String) {
        defaults.set(true, forKey: key(userId))
    }
}
