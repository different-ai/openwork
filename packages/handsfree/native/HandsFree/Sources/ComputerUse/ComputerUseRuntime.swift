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
    private var snapshotSequence = 0
    private var previousLabelsByWindow: [String: Set<String>] = [:]
    private var recentActions: [String] = []
    private var staleSnapshotReason: String?

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

    func snapshot(appName: String?, pid: Int? = nil, windowTitle: String? = nil, strict requestedStrict: Bool?) async throws -> AppSnapshot {
        let effectiveStrict = requestedStrict ?? strictMode
        if !effectiveStrict {
            resetBackgroundActivation()
        }

        let requestedPID = pid.map(pid_t.init)
        var target = try accessibility.resolveTarget(appName: appName, pid: requestedPID, windowTitle: windowTitle)
        let backgroundActivated: Bool
        if effectiveStrict, !target.isFrontmost {
            backgroundActivated = try await ensureBackgroundActivation(target: target)
            target = try accessibility.resolveTarget(appName: appName, pid: requestedPID, windowTitle: windowTitle)
        } else {
            backgroundActivated = false
        }

        let snapshot = try await accessibility.snapshot(
            target: target,
            strictMode: effectiveStrict,
            backgroundActivated: backgroundActivated
        )
        let annotatedSnapshot = annotate(snapshot: snapshot)
        staleSnapshotReason = nil
        lastSnapshot = annotatedSnapshot
        return annotatedSnapshot
    }

    func click(snapshotID: String?, ref: String?, index: Int?, imageX: Double?, imageY: Double?, screenX: Double? = nil, screenY: Double? = nil, clickCount: Int, strict requestedStrict: Bool?) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        try validateSnapshotForAction(snapshot: snapshot, strict: effectiveStrict)

        if let record = findRecord(ref: ref, index: index, in: snapshot) {
            let fresh = freshRecord(matching: record, in: snapshot)
            if let fresh {
                AgentCursorOverlay.shared.show(at: fresh.semantic.frame.center)
                if fresh.semantic.capabilities.canPress, accessibility.press(record: fresh) {
                    return recordAction(ActionMetadata(ok: true, path: .accessibility, strictMode: effectiveStrict, backgroundSafe: true, fallbackUsed: false, message: "Pressed \(fresh.semantic.ref) via AXPress."))
                }
                if fresh.semantic.capabilities.canFocus, accessibility.focus(record: fresh) {
                    return recordAction(ActionMetadata(ok: true, path: .accessibility, strictMode: effectiveStrict, backgroundSafe: true, fallbackUsed: false, message: "Focused \(fresh.semantic.ref) via AX."))
                }
                return try await clickPoint(fresh.semantic.frame.center, clickCount: clickCount, strict: effectiveStrict, fallbackUsed: true)
            }
            return try await clickPoint(record.semantic.frame.center, clickCount: clickCount, strict: effectiveStrict, fallbackUsed: true)
        }

        if let screenX, let screenY {
            return try await clickPoint(CGPoint(x: screenX, y: screenY), clickCount: clickCount, strict: effectiveStrict, fallbackUsed: false)
        }

        if let imageX, let imageY {
            let point = snapshot.screenshotMeta.toScreen(imageX: imageX, imageY: imageY)
            return try await clickPoint(point, clickCount: clickCount, strict: effectiveStrict, fallbackUsed: false)
        }

        throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
    }

    func typeText(snapshotID: String?, text: String, strict requestedStrict: Bool?) throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        try validateSnapshotForAction(snapshot: snapshot, strict: effectiveStrict)
        if effectiveStrict {
            try BackgroundInputDispatcher.typeText(pid: snapshot.pid, text: text)
            return recordAction(ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Typed text with postToPid."))
        }

        try foregroundInput.typeText(text)
        return recordAction(ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Typed text with foreground HID fallback."))
    }

    func pressKey(snapshotID: String?, combo: String, strict requestedStrict: Bool?) throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        try validateSnapshotForAction(snapshot: snapshot, strict: effectiveStrict)
        if effectiveStrict {
            try BackgroundInputDispatcher.pressKey(pid: snapshot.pid, combo: combo)
            return recordAction(ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Pressed key with postToPid."))
        }

        try foregroundInput.pressKey(combo)
        return recordAction(ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Pressed key with foreground HID fallback."))
    }

    func scroll(snapshotID: String?, direction: String?, pages: Double, imageX: Double?, imageY: Double?, strict requestedStrict: Bool?) throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        try validateSnapshotForAction(snapshot: snapshot, strict: effectiveStrict)
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
            return recordAction(ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Scrolled with postToPid."))
        }

        try foregroundInput.scroll(point: point, deltaX: deltas.x, deltaY: deltas.y)
        return recordAction(ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Scrolled with foreground HID fallback."))
    }

    func setValue(snapshotID: String?, ref: String?, index: Int?, value: String) throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        try validateSnapshotForAction(snapshot: snapshot, strict: snapshot.strictMode)
        guard let record = findRecord(ref: ref, index: index, in: snapshot) else {
            throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
        }
        guard let fresh = freshRecord(matching: record, in: snapshot) else {
            throw ComputerUseError.staleSnapshot("The target element changed. Take a new snapshot before setting its value.")
        }
        AgentCursorOverlay.shared.show(at: fresh.semantic.frame.center)
        let axWriteAccepted = accessibility.setValue(record: fresh, value: value)
        if axWriteAccepted, valueMatches(record: fresh, expected: value) {
            return recordAction(ActionMetadata(ok: true, path: .accessibility, strictMode: snapshot.strictMode, backgroundSafe: true, fallbackUsed: false, message: "Set \(fresh.semantic.ref) via AXValue."))
        }

        // Web inputs (Chromium/Electron) accept AXValue writes without applying
        // them. Fall back to focus + select-all + retype, then verify.
        _ = accessibility.focus(record: fresh)
        try BackgroundInputDispatcher.pressKey(pid: snapshot.pid, combo: "command+a")
        try BackgroundInputDispatcher.typeText(pid: snapshot.pid, text: value)
        Thread.sleep(forTimeInterval: 0.08)
        let verified = valueMatches(record: fresh, expected: value)
        return recordAction(ActionMetadata(
            ok: verified,
            path: .backgroundCGEvent,
            strictMode: snapshot.strictMode,
            backgroundSafe: true,
            fallbackUsed: true,
            message: verified
                ? "AXValue write did not stick; set \(fresh.semantic.ref) via select-all + retype fallback."
                : "Could not verify the value of \(fresh.semantic.ref) after AXValue and retype fallback."
        ))
    }

    private func valueMatches(record: AXElementRecord, expected: String) -> Bool {
        accessibility.value(record: record) == expected
    }

    func performAction(snapshotID: String?, ref: String?, index: Int?, action: String) throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        try validateSnapshotForAction(snapshot: snapshot, strict: snapshot.strictMode)
        guard let record = findRecord(ref: ref, index: index, in: snapshot) else {
            throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
        }
        guard let fresh = freshRecord(matching: record, in: snapshot) else {
            throw ComputerUseError.staleSnapshot("The target element changed. Take a new snapshot before performing another action.")
        }
        AgentCursorOverlay.shared.show(at: fresh.semantic.frame.center)
        let ok = accessibility.performAction(record: fresh, action: action)
        return recordAction(ActionMetadata(ok: ok, path: .accessibility, strictMode: snapshot.strictMode, backgroundSafe: true, fallbackUsed: false, message: ok ? "Performed \(action) on \(fresh.semantic.ref)." : "AX action \(action) failed."))
    }

    func wait(milliseconds: Int) async -> ActionMetadata {
        let clamped = max(0, min(milliseconds, 10_000))
        try? await Task.sleep(nanoseconds: UInt64(clamped) * 1_000_000)
        return ActionMetadata(ok: true, path: .none, strictMode: strictMode, backgroundSafe: true, fallbackUsed: false, message: "Waited \(clamped)ms.")
    }

    private func clickPoint(_ point: CGPoint, clickCount: Int, strict: Bool, fallbackUsed: Bool) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot()
        try validateSnapshotForAction(snapshot: snapshot, strict: strict)
        AgentCursorOverlay.shared.show(at: point)
        if strict {
            guard let windowNumber = snapshot.windowNumber else {
                throw ComputerUseError.strictModeViolation("background click requires a CG window number")
            }
            try await BackgroundInputDispatcher.click(pid: snapshot.pid, windowNumber: windowNumber, point: point, doubleClick: clickCount >= 2)
            return recordAction(ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: fallbackUsed, message: "Clicked with postToPid at \(Int(point.x)),\(Int(point.y))."))
        }

        try await foregroundInput.click(point: point, doubleClick: clickCount >= 2)
        return recordAction(ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Clicked with foreground HID fallback at \(Int(point.x)),\(Int(point.y))."))
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
        if pid == activationPreviousPID {
            staleSnapshotReason = "The user returned focus to the previous app. Take a new snapshot before sending more input."
        } else if pid == activationTargetPID {
            staleSnapshotReason = "The target app became frontmost. Take a new snapshot before continuing."
        } else {
            staleSnapshotReason = "The user changed app focus. Take a new snapshot before sending more input."
        }
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

    private func requireSnapshot(snapshotID: String? = nil) throws -> AppSnapshot {
        guard let lastSnapshot else { throw ComputerUseError.noSnapshot }
        if let snapshotID, snapshotID != lastSnapshot.id {
            throw ComputerUseError.staleSnapshot("Snapshot \(snapshotID) is no longer current. Take a new snapshot before retrying.")
        }
        return lastSnapshot
    }

    private func validateSnapshotForAction(snapshot: AppSnapshot, strict: Bool) throws {
        if let staleSnapshotReason {
            throw ComputerUseError.staleSnapshot(staleSnapshotReason)
        }
        guard strict else { return }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == snapshot.pid { return }
        guard activationSession != nil, activationTargetPID == snapshot.pid else {
            throw ComputerUseError.staleSnapshot("The target app is no longer safely activated. Take a new snapshot before retrying.")
        }
    }

    private func annotate(snapshot: AppSnapshot) -> AppSnapshot {
        snapshotSequence += 1
        let key = windowKey(snapshot: snapshot)
        let labels = Set(snapshot.records.map { stableLabel(for: $0.semantic) }.filter { !$0.isEmpty })
        let previous = previousLabelsByWindow[key] ?? []
        previousLabelsByWindow[key] = labels

        let added = labels.subtracting(previous).sorted()
        let removed = previous.subtracting(labels).sorted()
        return snapshot.withSessionMetadata(
            id: UUID().uuidString.lowercased(),
            observation: snapshotSequence,
            recentActions: Array(recentActions.suffix(8)),
            addedLabels: Array(added.prefix(16)),
            removedLabels: Array(removed.prefix(16))
        )
    }

    private func recordAction(_ metadata: ActionMetadata) -> ActionMetadata {
        recentActions.append(metadata.message)
        if recentActions.count > 12 {
            recentActions.removeFirst(recentActions.count - 12)
        }
        return metadata
    }

    private func freshRecord(matching record: AXElementRecord, in snapshot: AppSnapshot) -> AXElementRecord? {
        guard let target = try? accessibility.resolveTarget(appName: snapshot.appName, pid: snapshot.pid, windowTitle: snapshot.windowTitle) else {
            return nil
        }
        let records = accessibility.records(target: target)
        if let index = records.firstIndex(where: { $0.semantic.id == record.semantic.id }), stableMatch(records[index].semantic, record.semantic) {
            return records[index]
        }
        return records.first { stableMatch($0.semantic, record.semantic) }
    }

    private func stableMatch(_ candidate: SemanticAXElement, _ target: SemanticAXElement) -> Bool {
        candidate.role == target.role && stableLabel(for: candidate) == stableLabel(for: target)
    }

    private func stableLabel(for element: SemanticAXElement) -> String {
        let value = element.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let display = value.isEmpty ? label : "\(label) \(value)"
        return "\(element.role):\(display)"
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .lowercased()
    }

    private func windowKey(snapshot: AppSnapshot) -> String {
        "\(snapshot.pid):\(snapshot.windowNumber ?? -1)"
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
