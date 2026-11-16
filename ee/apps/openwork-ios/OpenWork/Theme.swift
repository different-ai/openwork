import OpenWorkKit
import SwiftUI

/// Layout values. Colors, materials and control shapes come from the system, so the app follows light and dark
/// appearance, contrast, text size and the system's own look without code here.
enum Layout {
    static let gutter: CGFloat = 16
    static let bubbleRadius: CGFloat = 20
    static let composerRadius: CGFloat = 22
}

/// The one main action on a screen: the system's prominent button at full width.
struct PrimaryButton: View {
    let title: LocalizedStringKey
    var isWorking = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if isWorking {
                    ProgressView().tint(Color(.systemBackground))
                } else {
                    Text(title)
                }
            }
            .font(.headline)
            // The accent is near-black in light appearance and near-white in dark, so the label takes the
            // background's color to stay readable on both.
            .foregroundStyle(Color(.systemBackground))
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .buttonSizing(.flexible)
        .controlSize(.large)
        .disabled(isWorking)
    }
}

/// The OpenWork mark, drawn in the accent color so it reads in light and dark.
struct MarkView: View {
    var size: CGFloat = 72

    var body: some View {
        Image("Mark")
            .resizable()
            .scaledToFit()
            .foregroundStyle(.tint)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The person's words for what went wrong. No message here offers a purchase or points to one.
enum Wording {
    static func sendProblem(_ problem: SendProblem) -> String {
        switch problem {
        case .tooLong: String(localized: "That's too long for one message.")
        case .sendingTooFast: String(localized: "You're sending messages quickly. Try again in a minute.")
        case .tooManyWaiting: String(localized: "Too many messages are waiting. Try again when this one is answered.")
        case .offline: String(localized: "You're offline. This will send when you try again.")
        case .cannotReach: String(localized: "That didn't send. Workbot can't be reached right now.")
        case let .refused(message): message ?? String(localized: "That didn't send.")
        }
    }

    static func modelIssue(_ issue: ModelIssue) -> String {
        switch issue {
        case .freeLimit: String(localized: "You've used the free model allowance for now. It refills on its own.")
        case .usageLimit: String(localized: "Your workspace reached its model usage limit. A workspace admin can change it.")
        case .paymentRequired: String(localized: "Workbot's model access needs attention. Ask a workspace admin.")
        }
    }

    static func unavailable(_ reason: UnavailableReason) -> String {
        switch reason {
        case .notEnabled: String(localized: "Workbot isn't on for your organization yet.")
        case .runnerUnavailable: String(localized: "Workbot is unavailable right now.")
        case .modelUnavailable: String(localized: "Workbot's model isn't set up yet. Ask a workspace admin.")
        }
    }

    static func signInProblem(_ problem: AppModel.SignInProblem) -> String {
        switch problem {
        case .failed: String(localized: "Signing in didn't finish. Try again.")
        case .cannotReach: String(localized: "Workbot can't reach OpenWork right now. Try again in a minute.")
        case .offline: String(localized: "You're offline. Connect and try again.")
        }
    }
}
