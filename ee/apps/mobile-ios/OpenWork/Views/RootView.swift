import AuthenticationServices
import OpenWorkKit
import SwiftUI

/// Shows the screen for where the app is: signing in, consent, locked, or the conversation.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.phase {
            case .launching:
                ProgressView()
            case .signedOut:
                SignInView()
            case .consent:
                ConsentView()
            case let .locked(reason):
                StatusView(
                    title: reason == .phoneOff ? "Workbot on iPhone Isn't On Yet" : "Workbot Isn't On Yet",
                    symbol: "lock",
                    detail: reason == .phoneOff
                        ? "A workspace admin can turn on Workbot for phones."
                        : "A workspace admin can turn on Workbot for your organization.",
                    actionTitle: "Check Again"
                )
            case let .unreachable(offline):
                StatusView(
                    title: offline ? "You're Offline" : "Can't Reach OpenWork",
                    symbol: offline ? "wifi.slash" : "exclamationmark.icloud",
                    detail: offline ? "Connect to the internet and try again." : "Try again in a minute.",
                    actionTitle: "Try Again"
                )
            case .chat:
                ChatView()
            }
        }
        .animation(.default, value: model.phase)
        .task { await model.start() }
    }
}

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                MarkView(size: 88)
                    .padding(.bottom, 12)
                Text("OpenWork")
                    .font(.largeTitle.bold())
                Text("Talk to Workbot, your workspace's AI coworker.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 24)
            .containerRelativeFrame(.vertical) { height, _ in height * 0.8 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 12) {
                if let problem = model.signInProblem {
                    Label(Wording.signInProblem(problem), systemImage: "exclamationmark.circle")
                        .font(.callout)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("sign-in-problem")
                }
                PrimaryButton(title: "Sign In with OpenWork", isWorking: model.isWorking) {
                    Task { await signIn() }
                }
                .accessibilityIdentifier("sign-in-button")
                Text(
                    "For members of workspaces that use OpenWork. By continuing you agree to the [Terms](https://openworklabs.com/terms) and [Privacy Policy](https://openworklabs.com/privacy)."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
    }

    /// Sign-in runs in the system's own sheet and returns only to this app, through an address the server owns.
    private func signIn() async {
        let attempt = model.beginSignIn()
        do {
            let callback = try await webAuthenticationSession.authenticate(
                using: attempt.loginURL,
                callback: .https(host: model.server.callbackHost, path: ServerConfiguration.callbackPath),
                additionalHeaderFields: [:]
            )
            await model.completeSignIn(callback: callback)
        } catch {
            model.signInEnded(cancelled: (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin)
        }
    }
}

/// Asked once per account before the first message: what Workbot is and where what you send goes.
struct ConsentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Before You Start")
                    .font(.largeTitle.bold())
                AIUseText()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 32)
        }
        // A bar the system knows about: the text fades under it instead of colliding with the buttons.
        .safeAreaBar(edge: .bottom) {
            VStack(spacing: 6) {
                PrimaryButton(title: "Agree and Continue") { model.agreeToAIUse() }
                    .accessibilityIdentifier("consent-agree")
                Button("Not Now") {
                    Task { await model.signOut() }
                }
                .controlSize(.large)
                .accessibilityIdentifier("consent-decline")
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 8)
        }
    }
}

/// How Workbot uses AI providers, in the words people agree to. Shown again from the account sheet.
struct AIUseText: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            point("sparkles", "Workbot is an AI assistant. Its answers can be wrong, so check anything important.")
            point(
                "arrow.up.right.circle",
                "To answer you, what you send and the work data Workbot uses on your behalf are sent to OpenWork and shared with third-party AI model providers chosen by OpenWork or your workspace admin, for example OpenAI."
            )
            point("hand.raised", "Don't send anything your workspace wouldn't want processed this way.")
            Text("See the [Privacy Policy](https://openworklabs.com/privacy) for what OpenWork collects and how to ask for it to be deleted.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func point(_ symbol: String, _ text: LocalizedStringKey) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(.tint)
        }
        .font(.body)
    }
}

/// A full-screen state with one thing to do and a way out, in the system's own form for it.
struct StatusView: View {
    @Environment(AppModel.self) private var model
    let title: LocalizedStringKey
    let symbol: String
    let detail: LocalizedStringKey
    let actionTitle: LocalizedStringKey

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(detail)
        } actions: {
            Button(actionTitle) {
                Task { await model.readProfile() }
            }
            .buttonStyle(.bordered)
            .disabled(model.isWorking)
            .accessibilityIdentifier("notice-action")
            Button("Sign Out") {
                Task { await model.signOut() }
            }
            .accessibilityIdentifier("notice-sign-out")
        }
    }
}
