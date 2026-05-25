import AppKit
import Foundation

actor ComputerUseRuntime {
    private let accessibility = AccessibilityService()
    private let foregroundInput = InputService()
    private var lastSnapshot: AppSnapshot?
    private var strictMode = true
    private var activationSession: BackgroundActivationSession?
    private var activationKey: String?
    private var activatedWindowKey: String?
    private var activationPreviousPID: pid_t?
    private var activationTargetPID: pid_t?
    private var frontmostMonitor: FrontmostApplicationMonitor?

    func setStrictMode(_ enabled: Bool) -> ActionMetadata {
        strictMode = enabled
        if !enabled {
            resetBackgroundActivation()
        }
        return ActionMetadata(
            ok: true,
            path: .none,
            strictMode: enabled,
            backgroundSafe: enabled,
            fallbackUsed: false,
            message: enabled ? "Strict background mode enabled." : "Strict background mode disabled. Foreground fallback is allowed."
        )
    }

    func snapshot(appName: String?, strict requestedStrict: Bool?) async throws -> AppSnapshot {
        let effectiveStrict = requestedStrict ?? strictMode
        if !effectiveStrict {
            resetBackgroundActivation()
        }

        var target = try accessibility.resolveTarget(appName: appName)
        let backgroundActivated: Bool
        if effectiveStrict, !target.isFrontmost {
            backgroundActivated = try await ensureBackgroundActivation(target: target)
            target = try accessibility.resolveTarget(appName: appName)
        } else {
            backgroundActivated = false
        }

        let snapshot = try await accessibility.snapshot(
            target: target,
            strictMode: effectiveStrict,
            backgroundActivated: backgroundActivated
        )
        lastSnapshot = snapshot
        return snapshot
    }

    func click(ref: String?, index: Int?, imageX: Double?, imageY: Double?, clickCount: Int, strict requestedStrict: Bool?) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot()
        let effectiveStrict = requestedStrict ?? snapshot.strictMode

        if let record = findRecord(ref: ref, index: index, in: snapshot) {
            AgentCursorOverlay.shared.show(at: record.semantic.frame.center)
            if record.semantic.capabilities.canPress, accessibility.press(record: record) {
                return ActionMetadata(ok: true, path: .accessibility, strictMode: effectiveStrict, backgroundSafe: true, fallbackUsed: false, message: "Pressed \(record.semantic.ref) via AXPress.")
            }
            if record.semantic.capabilities.canFocus, accessibility.focus(record: record) {
                return ActionMetadata(ok: true, path: .accessibility, strictMode: effectiveStrict, backgroundSafe: true, fallbackUsed: false, message: "Focused \(record.semantic.ref) via AX.")
            }
            return try await clickPoint(record.semantic.frame.center, clickCount: clickCount, strict: effectiveStrict, fallbackUsed: true)
        }

        if let imageX, let imageY {
            let point = snapshot.screenshotMeta.toScreen(imageX: imageX, imageY: imageY)
            return try await clickPoint(point, clickCount: clickCount, strict: effectiveStrict, fallbackUsed: false)
        }

        throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
    }

    func typeText(_ text: String, strict requestedStrict: Bool?) throws -> ActionMetadata {
        let snapshot = try requireSnapshot()
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        if effectiveStrict {
            try BackgroundInputDispatcher.typeText(pid: snapshot.pid, text: text)
            return ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Typed text with postToPid.")
        }

        try foregroundInput.typeText(text)
        return ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Typed text with foreground HID fallback.")
    }

    func pressKey(_ combo: String, strict requestedStrict: Bool?) throws -> ActionMetadata {
        let snapshot = try requireSnapshot()
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        if effectiveStrict {
            try BackgroundInputDispatcher.pressKey(pid: snapshot.pid, combo: combo)
            return ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Pressed key with postToPid.")
        }

        try foregroundInput.pressKey(combo)
        return ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Pressed key with foreground HID fallback.")
    }

    func scroll(direction: String?, pages: Double, imageX: Double?, imageY: Double?, strict requestedStrict: Bool?) throws -> ActionMetadata {
        let snapshot = try requireSnapshot()
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        let amount = max(1, Int32(pages * 5))
        let deltas = scrollDeltas(direction: direction, amount: amount)
        let point: CGPoint = {
            if let imageX, let imageY {
                return snapshot.screenshotMeta.toScreen(imageX: imageX, imageY: imageY)
            }
            return CGPoint(x: snapshot.screenshotMeta.capturedBounds.midX, y: snapshot.screenshotMeta.capturedBounds.midY)
        }()
        AgentCursorOverlay.shared.show(at: point)

        if effectiveStrict {
            guard let windowNumber = snapshot.windowNumber else {
                throw ComputerUseError.strictModeViolation("background scroll requires a CG window number")
            }
            try BackgroundInputDispatcher.scroll(pid: snapshot.pid, windowNumber: windowNumber, point: point, deltaX: deltas.x, deltaY: deltas.y)
            return ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Scrolled with postToPid.")
        }

        try foregroundInput.scroll(point: point, deltaX: deltas.x, deltaY: deltas.y)
        return ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Scrolled with foreground HID fallback.")
    }

    func setValue(ref: String?, index: Int?, value: String) throws -> ActionMetadata {
        let snapshot = try requireSnapshot()
        guard let record = findRecord(ref: ref, index: index, in: snapshot) else {
            throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
        }
        AgentCursorOverlay.shared.show(at: record.semantic.frame.center)
        let ok = accessibility.setValue(record: record, value: value)
        return ActionMetadata(ok: ok, path: .accessibility, strictMode: snapshot.strictMode, backgroundSafe: true, fallbackUsed: false, message: ok ? "Set \(record.semantic.ref) via AXValue." : "Element value is not settable.")
    }

    func performAction(ref: String?, index: Int?, action: String) throws -> ActionMetadata {
        let snapshot = try requireSnapshot()
        guard let record = findRecord(ref: ref, index: index, in: snapshot) else {
            throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
        }
        AgentCursorOverlay.shared.show(at: record.semantic.frame.center)
        let ok = accessibility.performAction(record: record, action: action)
        return ActionMetadata(ok: ok, path: .accessibility, strictMode: snapshot.strictMode, backgroundSafe: true, fallbackUsed: false, message: ok ? "Performed \(action) on \(record.semantic.ref)." : "AX action \(action) failed.")
    }

    func wait(milliseconds: Int) async -> ActionMetadata {
        let clamped = max(0, min(milliseconds, 10_000))
        try? await Task.sleep(nanoseconds: UInt64(clamped) * 1_000_000)
        return ActionMetadata(ok: true, path: .none, strictMode: strictMode, backgroundSafe: true, fallbackUsed: false, message: "Waited \(clamped)ms.")
    }

    private func clickPoint(_ point: CGPoint, clickCount: Int, strict: Bool, fallbackUsed: Bool) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot()
        AgentCursorOverlay.shared.show(at: point)
        if strict {
            guard let windowNumber = snapshot.windowNumber else {
                throw ComputerUseError.strictModeViolation("background click requires a CG window number")
            }
            try await BackgroundInputDispatcher.click(pid: snapshot.pid, windowNumber: windowNumber, point: point, doubleClick: clickCount >= 2)
            return ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: fallbackUsed, message: "Clicked with postToPid at \(Int(point.x)),\(Int(point.y)).")
        }

        try await foregroundInput.click(point: point, doubleClick: clickCount >= 2)
        return ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Clicked with foreground HID fallback at \(Int(point.x)),\(Int(point.y)).")
    }

    private func ensureBackgroundActivation(target: WindowTarget) async throws -> Bool {
        ensureFrontmostMonitor()
        guard let previousPID = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            throw ComputerUseError.noFrontmostApplication
        }
        let nextActivationKey = "\(previousPID):\(target.pid)"
        if activationKey != nextActivationKey {
            resetBackgroundActivation()
            let next = BackgroundActivationSession(previousPID: previousPID, targetPID: target.pid)
            try next.start()
            activationSession = next
            activationKey = nextActivationKey
            activationPreviousPID = previousPID
            activationTargetPID = target.pid
            activatedWindowKey = nil
        }

        let nextWindowKey = "\(target.pid):\(target.windowNumber ?? -1)"
        if activatedWindowKey != nextWindowKey {
            guard let activationSession else {
                throw ComputerUseError.strictModeViolation("background activation session was not created")
            }
            try await activationSession.activate(target: target)
            activatedWindowKey = nextWindowKey
        }
        return true
    }

    private func ensureFrontmostMonitor() {
        if frontmostMonitor != nil { return }
        frontmostMonitor = FrontmostApplicationMonitor { [weak self] pid in
            guard let runtime = self else { return }
            Task { await runtime.frontmostApplicationChanged(pid: pid) }
        }
    }

    private func frontmostApplicationChanged(pid: pid_t?) {
        guard let pid, activationSession != nil else { return }
        if pid == activationPreviousPID { return }
        resetBackgroundActivation()
    }

    private func resetBackgroundActivation() {
        activationSession?.stop()
        activationSession = nil
        activationKey = nil
        activatedWindowKey = nil
        activationPreviousPID = nil
        activationTargetPID = nil
    }

    private func requireSnapshot() throws -> AppSnapshot {
        guard let lastSnapshot else { throw ComputerUseError.noSnapshot }
        return lastSnapshot
    }

    private func findRecord(ref: String?, index: Int?, in snapshot: AppSnapshot) -> AXElementRecord? {
        if let ref {
            let normalized = normalizeRef(ref)
            return snapshot.records.first { $0.semantic.ref == normalized }
        }
        if let index {
            if let byID = snapshot.records.first(where: { $0.semantic.id == index }) {
                return byID
            }
            if index >= 0 && index < snapshot.records.count {
                return snapshot.records[index]
            }
        }
        return nil
    }

    private func normalizeRef(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{e"), trimmed.hasSuffix("}") { return trimmed }
        if trimmed.hasPrefix("e") { return "{\(trimmed)}" }
        return "{e\(trimmed)}"
    }

    private func scrollDeltas(direction: String?, amount: Int32) -> (x: Int32, y: Int32) {
        switch direction?.lowercased() ?? "down" {
        case "up": return (0, amount)
        case "left": return (amount, 0)
        case "right": return (-amount, 0)
        default: return (0, -amount)
        }
    }
}
