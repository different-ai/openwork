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
                NoticeView(
                    title: reason == .phoneOff ? "Workbot on phones isn't on for your workspace yet." : "Workbot isn't on for your organization yet.",
                    detail: "A workspace admin can turn it on.",
                    actionTitle: "Check again"
                )
            case let .unreachable(offline):
                NoticeView(
                    title: offline ? "You're offline." : "Workbot can't reach OpenWork right now.",
                    detail: offline ? "Connect to the internet and try again." : "Try again in a minute.",
                    actionTitle: "Try again"
                )
            case .chat:
                ChatView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .preferredColorScheme(.light)
        .task { await model.start() }
    }
}

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Image("Mark")
                .resizable()
                .frame(width: 96, height: 96)
                .clipShape(.rect(cornerRadius: 22))
                .accessibilityHidden(true)
            Text("OpenWork")
                .font(.largeTitle.bold())
                .foregroundStyle(Theme.ink)
                .padding(.top, 20)
            Text("Talk to Workbot, your workspace's AI coworker.")
                .font(.body)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .padding(.top, 6)
            Spacer()
            if let problem = model.signInProblem {
                Text(Wording.signInProblem(problem))
                    .font(.callout)
                    .foregroundStyle(Theme.danger)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 12)
                    .accessibilityIdentifier("sign-in-problem")
            }
            Button {
                Task { await signIn() }
            } label: {
                Group {
                    if model.isWorking {
                        ProgressView().tint(.white)
                    } else {
                        Text("Sign in with OpenWork")
                    }
                }
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 28)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isWorking)
            .accessibilityIdentifier("sign-in-button")

            Text(
                "For members of workspaces that use OpenWork. By continuing you agree to the [Terms](https://openworklabs.com/terms) and [Privacy Policy](https://openworklabs.com/privacy)."
            )
            .font(.footnote)
            .foregroundStyle(Theme.muted)
            .multilineTextAlignment(.center)
            .padding(.top, 14)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
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
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Before you start")
                        .font(.largeTitle.bold())
                        .foregroundStyle(Theme.ink)
                    AIUseText()
                }
                .padding(.top, 32)
            }
            Button {
                model.agreeToAIUse()
            } label: {
                Text("Agree and continue").font(.headline).frame(maxWidth: .infinity, minHeight: 28)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("consent-agree")
            Button("Not now") {
                Task { await model.signOut() }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 14)
            .accessibilityIdentifier("consent-decline")
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
    }
}

/// How Workbot uses AI providers, in the words people agree to. Shown again from the account sheet.
struct AIUseText: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            point("sparkles", "Workbot is an AI assistant. Its answers can be wrong, so check anything important.")
            point(
                "arrow.up.right.circle",
                "To answer you, what you send and the work data Workbot uses on your behalf are sent to OpenWork and shared with third-party AI model providers chosen by OpenWork or your workspace admin, for example OpenAI."
            )
            point("hand.raised", "Don't send anything your workspace wouldn't want processed this way.")
            Text("See the [Privacy Policy](https://openworklabs.com/privacy) for what OpenWork collects and how to ask for it to be deleted.")
                .font(.callout)
                .foregroundStyle(Theme.muted)
        }
    }

    private func point(_ symbol: String, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(Theme.ink)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(text)
                .font(.body)
                .foregroundStyle(Theme.text)
        }
    }
}

/// A full-screen message with one thing to do and a way out.
struct NoticeView: View {
    @Environment(AppModel.self) private var model
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let actionTitle: LocalizedStringKey

    var body: some View {
        VStack(spacing: 10) {
            Spacer()
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .multilineTextAlignment(.center)
            Text(detail)
                .font(.body)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            Button {
                Task { await model.readProfile() }
            } label: {
                if model.isWorking {
                    ProgressView()
                } else {
                    Text(actionTitle)
                }
            }
            .buttonStyle(.bordered)
            .padding(.top, 10)
            .disabled(model.isWorking)
            .accessibilityIdentifier("notice-action")
            Spacer()
            Button("Sign out") {
                Task { await model.signOut() }
            }
            .accessibilityIdentifier("notice-sign-out")
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
    }
}
