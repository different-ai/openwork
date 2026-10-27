import Darwin
import Foundation
import Security

/// mcp-embedded trusts its stdin peer to control sessions, so the mode
/// selector alone is not authentication: a team-signed helper only serves a
/// parent process signed by the same team (the OpenWork desktop).
enum HostTrust {
    static func embeddedHostIsTrusted() -> Bool {
        guard let team = teamIdentifier() else {
            // An unsigned helper cannot authenticate its host. Both MCP modes
            // require a signed peer; standalone mode is no bypass.
            return false
        }
        guard team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return false }
        let parent = getppid()
        guard parent > 1 else { return false }
        var guest: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: parent] as CFDictionary, [], &guest) == errSecSuccess,
              let guest else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString("anchor apple generic and certificate leaf[subject.OU] = \"\(team)\"" as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(guest, [], requirement) == errSecSuccess
    }

    private static func teamIdentifier() -> String? {
        var current: SecCode?
        var code: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopySelf([], &current) == errSecSuccess, let current,
              SecCodeCopyStaticCode(current, [], &code) == errSecSuccess, let code,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any] else { return nil }
        return values[kSecCodeInfoTeamIdentifier as String] as? String
    }
}
