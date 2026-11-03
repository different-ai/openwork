import Darwin
import Foundation
import Security

/// mcp-embedded trusts its stdin peer to control sessions, so the mode
/// selector alone is not authentication: a team-signed helper only serves the
/// OpenWork desktop app itself. Other code the team signs, such as the bundled
/// sidecars, is not a host. After the responsibility relaunch the parent is
/// this helper's own first process, which already checked the desktop.
enum HostTrust {
    /// The appId of every signed desktop distribution. Demo builds are unsigned.
    static let desktopIdentifier = "com.differentai.openwork"

    static func embeddedHostIsTrusted() -> Bool {
        guard let signer = signingIdentity() else {
            // An unsigned helper cannot authenticate its host. Both MCP modes
            // require a signed peer; standalone mode is no bypass.
            return false
        }
        let host = Responsibility.relaunched ? signer.identifier : desktopIdentifier
        return process(getppid(), isSignedAs: host, team: signer.team)
    }

    static func process(_ pid: pid_t, isSignedAs identifier: String, team: String) -> Bool {
        guard team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil,
              identifier.range(of: "^[A-Za-z0-9.-]+$", options: .regularExpression) != nil,
              pid > 1 else { return false }
        var guest: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &guest) == errSecSuccess,
              let guest else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString("identifier \"\(identifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\"" as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(guest, [], requirement) == errSecSuccess
    }

    private static func signingIdentity() -> (team: String, identifier: String)? {
        var current: SecCode?
        var code: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopySelf([], &current) == errSecSuccess, let current,
              SecCodeCopyStaticCode(current, [], &code) == errSecSuccess, let code,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any],
              let team = values[kSecCodeInfoTeamIdentifier as String] as? String,
              let identifier = values[kSecCodeInfoIdentifier as String] as? String else { return nil }
        return (team, identifier)
    }
}
