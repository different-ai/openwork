import OpenWorkKit
import SwiftUI

/// Design values, matching the Workbot web page's (`ee/packages/workbot-ui/src/styles.css`).
enum Theme {
    static let background = Color(red: 0xFB / 255, green: 0xFC / 255, blue: 0xFD / 255)
    static let surface = Color.white
    static let ink = Color(red: 0x01 / 255, green: 0x16 / 255, blue: 0x27 / 255)
    static let text = Color(red: 0x11 / 255, green: 0x18 / 255, blue: 0x1C / 255)
    static let muted = Color(red: 0x68 / 255, green: 0x70 / 255, blue: 0x76 / 255)
    static let userBubble = Color(red: 0xEE / 255, green: 0xF1 / 255, blue: 0xF4 / 255)
    static let chip = Color(red: 0xF1 / 255, green: 0xF3 / 255, blue: 0xF5 / 255)
    static let hairline = Color(red: 0x01 / 255, green: 0x16 / 255, blue: 0x27 / 255).opacity(0.09)
    static let danger = Color(red: 0xC4 / 255, green: 0x30 / 255, blue: 0x2B / 255)

    static let bubbleRadius: CGFloat = 18
    static let gutter: CGFloat = 16
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
