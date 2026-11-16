import Foundation
import Observation

/// Where the app is: signing in, asking for consent, locked, or in the conversation.
@MainActor
@Observable
public final class AppModel {
    public enum Phase: Equatable, Sendable {
        case launching
        case signedOut
        /// Signed in, but the person has not yet agreed to how Workbot uses AI providers.
        case consent
        case locked(LockReason)
        /// Signed in, but OpenWork cannot be reached to say who this is.
        case unreachable(offline: Bool)
        case chat
    }

    public enum LockReason: Equatable, Sendable {
        /// The workspace has not turned Workbot on for phones.
        case phoneOff
        /// The workspace does not have Workbot.
        case workbotOff
    }

    public enum SignInProblem: Equatable, Sendable {
        case failed
        case cannotReach
        case offline
    }

    public private(set) var phase: Phase = .launching
    public private(set) var me: Me?
    public private(set) var signInProblem: SignInProblem?
    /// Finishing a sign-in or reading who is signed in.
    public private(set) var isWorking = false
    public let chat: ChatModel
    public let server: ServerConfiguration

    private let client: WorkbotClient
    private let consent: any ConsentStoring
    private var attempt: SignInAttempt?

    public init(server: ServerConfiguration, client: WorkbotClient, consent: any ConsentStoring) {
        self.server = server
        self.client = client
        self.consent = consent
        chat = ChatModel(client: client)
        chat.onSignedOut = { [weak self] in self?.becomeSignedOut() }
        chat.onPhoneNotEnabled = { [weak self] in self?.lock(.phoneOff) }
    }

    /// Call once at launch.
    public func start() async {
        guard client.isSignedIn else {
            phase = .signedOut
            return
        }
        await readProfile()
    }

    // MARK: Signing in and out

    /// Starts a sign-in and returns the page to open in the system's sign-in sheet.
    public func beginSignIn() -> SignInAttempt {
        let attempt = SignIn.begin(server: server)
        self.attempt = attempt
        signInProblem = nil
        return attempt
    }

    /// The sign-in sheet closed without an answer. Closing it on purpose is not a problem to report.
    public func signInEnded(cancelled: Bool) {
        attempt = nil
        signInProblem = cancelled ? nil : .failed
    }

    /// The sign-in sheet returned to the app.
    public func completeSignIn(callback: URL) async {
        guard let attempt else {
            signInProblem = .failed
            return
        }
        self.attempt = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let code = try SignIn.code(from: callback, for: attempt)
            try await client.exchange(code: code, attempt: attempt)
        } catch {
            signInProblem = switch error as? APIFailure {
            case .offline: .offline
            case .unavailable: .cannotReach
            default: .failed
            }
            return
        }
        await readProfile()
    }

    public func signOut() async {
        await client.signOut()
        becomeSignedOut()
    }

    // MARK: Consent

    public func agreeToAIUse() {
        guard let me else { return }
        consent.recordAgreement(userId: me.userId)
        enter(me)
    }

    // MARK: Profile

    /// Asks again who is signed in: after a lock or an outage, or when the app comes back to the front.
    public func readProfile() async {
        isWorking = true
        defer { isWorking = false }
        do {
            let me = try await client.me()
            self.me = me
            enter(me)
        } catch APIFailure.signedOut {
            becomeSignedOut()
        } catch APIFailure.phoneNotEnabled {
            lock(.phoneOff)
        } catch {
            // Keep the conversation on screen through a blip; only an app with nothing to show says so.
            if phase != .chat {
                phase = .unreachable(offline: error as? APIFailure == .offline)
            }
        }
    }

    private func enter(_ me: Me) {
        // The server reports phones as allowed only where Workbot itself is on, so ask about Workbot first.
        if !me.enabled {
            lock(.workbotOff)
        } else if !me.mobile {
            lock(.phoneOff)
        } else if !consent.hasAgreed(userId: me.userId) {
            phase = .consent
        } else {
            phase = .chat
        }
    }

    private func lock(_ reason: LockReason) {
        chat.deactivate()
        phase = .locked(reason)
    }

    private func becomeSignedOut() {
        chat.reset()
        me = nil
        attempt = nil
        phase = .signedOut
    }
}
