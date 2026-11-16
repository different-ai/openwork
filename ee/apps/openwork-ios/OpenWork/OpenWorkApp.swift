import OpenWorkKit
import SwiftUI

@main
struct OpenWorkApp: App {
    @State private var model = AppSetup.makeModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.ink)
        }
    }
}

/// The app's fixed addresses.
enum Links {
    static let privacy = URL(string: "https://openworklabs.com/privacy")!
    static let terms = URL(string: "https://openworklabs.com/terms")!
    static let supportAddress = "team@openworklabs.com"

    static func support(subject: String, body: String = "") -> URL {
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = supportAddress
        components.queryItems = [URLQueryItem(name: "subject", value: subject)] + (body.isEmpty ? [] : [URLQueryItem(name: "body", value: body)])
        return components.url ?? URL(string: "mailto:\(supportAddress)")!
    }
}

enum AppSetup {
    /// The server comes from the build (`OpenWorkServerURL` in Info.plist) and the session lives in the Keychain.
    static func makeModel() -> AppModel {
        var serverURL = (Bundle.main.object(forInfoDictionaryKey: "OpenWorkServerURL") as? String).flatMap(URL.init(string:))
            ?? URL(string: "https://chat.openworklabs.com")!
        var store: any SessionStoring = KeychainSessionStore(service: (Bundle.main.bundleIdentifier ?? "com.differentai.openwork") + ".session")
        var consent: any ConsentStoring = DefaultsConsentStore()

        #if DEBUG
            // Development builds only: point the app at a local stand-in server and start signed in, so screens can be
            // checked in the simulator. See README.md, "Run it against the stand-in server".
            let arguments = UserDefaults.standard
            if let override = arguments.string(forKey: "OpenWorkServerURL").flatMap(URL.init(string:)) {
                serverURL = override
            }
            if let session = arguments.string(forKey: "OpenWorkDevelopmentSession") {
                store = MemorySessionStore(AppSession(token: session, expiresAt: Date.distantFuture.timeIntervalSince1970 * 1000))
                consent = DevelopmentConsent(agreed: arguments.bool(forKey: "OpenWorkDevelopmentConsent"))
            }
        #endif

        let server = ServerConfiguration(baseURL: serverURL)
        return AppModel(server: server, client: WorkbotClient(server: server, store: store), consent: consent)
    }
}

#if DEBUG
    /// Consent for a development run: starts as the launch argument says and is forgotten when the app quits.
    private final nonisolated class DevelopmentConsent: ConsentStoring, @unchecked Sendable {
        private let lock = NSLock()
        private var agreed: Bool

        init(agreed: Bool) {
            self.agreed = agreed
        }

        func hasAgreed(userId _: String) -> Bool {
            lock.withLock { agreed }
        }

        func recordAgreement(userId _: String) {
            lock.withLock { agreed = true }
        }
    }
#endif
