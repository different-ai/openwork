import AppKit
import ApplicationServices

@MainActor
final class SessionRuntime {
    private let access = MacAccessibility()
    private let input = MacInput()
    private let controls = SessionControls()
    private let policy: RuntimePolicy
    private var session: Session?
    private var lease: ControlLease?
    private var busy = false
    private var resumingSessionID: String?
    private var watch = WatchLease()
    private var watchTimer: Timer?
    private var watchCapture: Task<Void, Never>?
    private var lastWatchCaptureAt: TimeInterval = -.infinity

    private struct Session {
        let id: String
        let app: AppIdentity
        let target: WindowTarget
        let mode: AccessMode
        let started: TimeInterval
        var lastUsed: TimeInterval
        var generation = 0
        var paused = false
        var pauseReason: String?
        var interactionDeadline: TimeInterval?
        var recoverableInterruption = false
        var needsRefresh = true
        let purpose: String
        var observation: ObservationLease?
        var records: [ElementRecord] = []
        var actionCount = 0
        var receipts: [String: [String: Any]] = [:]
        var receiptInputs: [String: Data] = [:]
        var focus: ElementRecord?
    }
    init(policy: RuntimePolicy = .desktop) {
        self.policy = policy
        controls.onPause = { [weak self] reason in self?.pause(reason) }
        controls.onAppSwitch = { [weak self] in self?.personInteracted() }
        controls.onUserInteraction = { [weak self] in self?.personInteracted() }
        controls.onResume = { [weak self] in Task { await self?.resume() } }
        controls.onStop = { [weak self] in self?.close() }
        controls.onTick = { [weak self] in self?.expire() }
        controls.onWatch = { [weak self] visible in self?.watchWindow(visible: visible) }
    }
    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    func call(_ name: String, _ values: [String: Any]) async throws -> [[String: Any]] {
        let a = Arguments(values: values)
        if name == "computer_close_session" {
            try a.only(["session_id"])
            let id = try a.string("session_id")
            guard session?.id == id else { throw UseError("session_unavailable", "This connection does not own that session.", next: "open_session") }
            close()
            return text(["ok": true, "state": "closed"])
        }
        guard !busy else { throw UseError("busy", "A computer operation is still running. Calls must be sequential.", next: "wait") }
        watch.invalidate(); watchCapture?.cancel(); MCPOutput.shared.discardUnsentFrame()
        busy = true; defer { busy = false }
        switch name {
        case "computer_discover":
            try a.only([])
            return text(discover())
        case "computer_open_session":
            try a.only(["app_id", "pid", "mode", "purpose"])
            guard session == nil else { throw UseError("session_exists", "Close this connection's session before opening another.", next: "close_session") }
            defer { if session == nil { controls.close() } }
            let appID = try a.string("app_id")
            let pid = values["pid"] == nil ? nil : pid_t(try a.integer("pid", min: 1, max: Int(Int32.max)))
            guard let mode = AccessMode(rawValue: try a.string("mode")) else { throw UseError("invalid_arguments", "mode must be observe, assist, or control.") }
            let purpose = try a.string("purpose", max: 500)
            try access.requirePermissions()
            let reservation = try ControlLease()
            let identity = try await AppIdentity.open(appID, pid: pid)
            var windows = try await access.windows(identity)
            if windows.isEmpty {
                // Reopen a running app's normal window through Launch Services.
                // This grants no read/input access; window consent still follows.
                if let url = identity.app.bundleURL {
                    let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true
                    _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
                    windows = try await access.windows(identity)
                }
            }
            guard !windows.isEmpty else { throw UseError("window_unavailable", "The app opened, but did not expose a usable window. Check for a sign-in or app dialog, then request a session again.", next: "human_takeover") }
            try Task.checkCancellation()
            let target = try await controls.chooseWindow(app: identity, mode: mode, windows: windows, purpose: purpose)
            try Task.checkCancellation()
            _ = try access.validate(target, app: identity)
            let id = UUID().uuidString.lowercased()
            session = Session(id: id, app: identity, target: target, mode: mode, started: now, lastUsed: now, purpose: purpose)
            lease = reservation
            controls.show(app: identity, target: target, mode: mode, purpose: purpose)
            if mode == .control {
                // The person's approval also authorizes initial foreground control.
                pause("Starting the approved window…")
                await resume()
            }
            guard let opened = session, opened.id == id else { throw UseError("session_unavailable", "Access ended while starting. Stop work and wait for a new user request.", next: "human_takeover") }
            return text(["ok": true, "session_id": id, "app_id": identity.bundleID, "app_name": identity.name, "pid": Int(identity.pid),
                "window_id": Int(target.id), "window_title": target.title, "mode": mode.rawValue,
                "state": opened.paused ? "paused" : "active", "expires_in_seconds": 900,
                "next": next(opened)])
        case "computer_observe":
            let options = try ObservationOptions(values, policy: policy)
            return try await observe(try a.string("session_id"), image: options.image, elements: options.elements)
        case "computer_act":
            try a.only(policy == .coworker ? ["session_id", "observation_id", "request_id", "action", "actions"] : ["session_id", "observation_id", "request_id", "action"])
            let id = try a.string("session_id")
            let observationID = try a.string("observation_id")
            let requestID = try a.string("request_id", max: 100)
            let actions = try Action.batch(values, policy: policy)
            let raw = values["actions"] ?? values["action"] ?? NSNull()
            return try await act(id: id, observationID: observationID, requestID: requestID, actions: actions, raw: raw)
        case "computer_session_status":
            try a.only(["session_id"])
            let current = try current(try a.string("session_id"), allowPaused: true)
            var status: [String: Any] = ["ok": true, "session_id": current.id, "mode": current.mode.rawValue,
                "state": current.paused ? "paused" : "active", "phase": phase(current),
                "purpose": current.purpose, "app_name": current.app.name, "window_title": current.target.title, "panel_visible": controls.isVisible,
                "actions": current.actionCount,
                "expires_in_seconds": max(0, Int(900 - (now - current.started))),
                "next": next(current)]
            if let reason = current.pauseReason { status["pause_reason"] = reason }
            return text(status)
        default: throw UseError("unknown_tool", "Unknown tool. Refresh the Computer Use tool list.", next: "discover")
        }
    }

    private func discover() -> [String: Any] {
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && AppIdentity.isAllowed($0) }
            .compactMap { app -> [String: Any]? in
                guard let id = app.bundleIdentifier else { return nil }
                return ["app_id": id, "name": app.localizedName ?? id, "pid": Int(app.processIdentifier)]
            }.sorted { String(describing: $0["name"]) < String(describing: $1["name"]) }
        let runningIDs = Set(running.compactMap { $0["app_id"] as? String })
        let apps = (running + AppIdentity.installedApps().filter { !runningIDs.contains($0["app_id"] as? String ?? "") })
            .sorted { String(describing: $0["name"]) < String(describing: $1["name"]) }
        var limits = ["session_seconds": 900, "idle_seconds": 120, "observation_seconds": Int(policy.observationSeconds), "actions": 200]
        var result: [String: Any] = ["ok": true, "protocol": "openwork.computer-use/1", "platform": "macos",
            "permissions": Self.permissions(), "apps": apps,
            "modes": AccessMode.allCases.map { ["id": $0.rawValue, "description": $0.explanation] },
            "keys": policy.keys, "guidance": policy.guidance]
        if policy == .coworker {
            limits["batch_actions"] = Action.batchLimit
            result["modifiers"] = NativeKey.supportedModifiers
            result["shortcuts"] = NativeKey.shortcuts.sorted()
            result["blocked_shortcuts"] = NativeKey.blockedShortcuts
        }
        result["limits"] = limits
        return result
    }
    private func watchWindow(visible: Bool) {
        guard SessionControls.embeddedCoworker, session != nil else { return }
        watch.update(visible: visible, now: now)
        if !visible {
            watchCapture?.cancel(); watchTimer?.invalidate(); watchTimer = nil
            MCPOutput.shared.discardUnsentFrame()
            return
        }
        if watchTimer == nil {
            let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.captureWatchFrame() }
            }
            watchTimer = timer; RunLoop.main.add(timer, forMode: .common)
        }
        captureWatchFrame()
    }

    private func captureWatchFrame() {
        guard watch.isVisible(now: now) else {
            watchTimer?.invalidate(); watchTimer = nil; watchCapture?.cancel()
            MCPOutput.shared.discardUnsentFrame()
            return
        }
        guard watchCapture == nil, !busy, resumingSessionID == nil,
              let current = session, !current.paused, now - current.started < 900,
              now - current.lastUsed < 120, now - lastWatchCaptureAt >= 0.2,
              MCPOutput.shared.canSendFrame else { return }
        let generation = watch.generation
        lastWatchCaptureAt = now
        watchCapture = Task { [weak self] in
            guard let self else { return }
            defer { self.watchCapture = nil }
            @MainActor func check() throws {
                try Task.checkCancellation()
                guard let latest = self.session, latest.id == current.id, latest.generation == current.generation,
                      latest.target.id == current.target.id, latest.app.pid == current.app.pid,
                      CFEqual(latest.target.element, current.target.element), !latest.paused,
                      self.watch.generation == generation, self.watch.isVisible(now: self.now),
                      !self.busy, self.resumingSessionID == nil, self.now - latest.started < 900,
                      self.now - latest.lastUsed < 120, MCPOutput.shared.canSendFrame else {
                    throw UseError("watch_inactive", "The embedded view is no longer watching.")
                }
            }
            do {
                try check()
                let bounds = try self.access.validate(current.target, app: current.app)
                let state = try await self.access.read(current.target, check: check)
                try state.requireCapture()
                try check()
                let captured = try await self.access.capture(target: current.target, app: current.app,
                    bounds: bounds, state: state, check: {
                        try check()
                        guard try self.access.validate(current.target, app: current.app) == bounds else {
                            throw UseError("stale_observation", "The watched window changed.")
                        }
                    })
                try check()
                guard try self.access.validate(current.target, app: current.app) == bounds else { return }
                try check()
                // Never install a lease, records, preview, or lastUsed from a UI frame.
                self.controls.frame(captured.0, width: captured.1, height: captured.2, capturedAt: captured.3)
            } catch {
                // Read-only races, revocation, and backpressure drop this frame.
                // A subsequent heartbeat may watch; it cannot recover control.
            }
        }
    }

    private func stopWatching() {
        watch.update(visible: false, now: now); watchCapture?.cancel()
        watchTimer?.invalidate(); watchTimer = nil
        MCPOutput.shared.discardUnsentFrame()
    }
    static func permissions() -> [String: Any] {
        let ax = AXIsProcessTrusted(); let capture = CGPreflightScreenCaptureAccess()
        return ["ok": ax && capture, "accessibility": ax, "screenRecording": capture,
            "supported": true, "protocolVersion": "openwork.computer-use/1"]
    }
    private func current(_ id: String, allowPaused: Bool = false) throws -> Session {
        expire()
        guard let current = session, current.id == id else { throw UseError("session_unavailable", "This session ended or belongs to another connection. Open a new session.", next: "open_session") }
        if current.paused && !allowPaused { throw interruption(current) }
        try Task.checkCancellation()
        try current.app.validate()
        return current
    }
    private func interruption(_ current: Session) -> UseError {
        if current.recoverableInterruption {
            let waiting = current.interactionDeadline.map { now < $0 } ?? false
            return UseError(waiting ? "user_interacting" : "requery_required",
                waiting ? "The person is still interacting. Wait one second, then observe again. Do not send actions." : "The person changed the app. Observe the latest state before sending actions.",
                next: waiting ? "wait_then_observe" : "observe")
        }
        return UseError("session_paused", "The person must choose Continue in the Computer Use controls. Do not retry automatically.", next: "human_takeover")
    }
    private func checkActive(_ expected: Session, deadline: TimeInterval? = nil) throws {
        try Task.checkCancellation()
        guard let current = session, current.id == expected.id else {
            throw UseError("session_changed", "Access ended during this operation. No remaining input is allowed.", next: "human_takeover")
        }
        if current.paused { throw interruption(current) }
        guard current.generation == expected.generation else {
            throw UseError("session_changed", "Control changed during this operation. A new observation is required.", next: "human_takeover")
        }
        if now - current.started >= 900 { close(); throw UseError("session_expired", "The session expired.", next: "human_takeover") }
        if now - current.lastUsed >= 120 { pause("Paused after two minutes without activity."); throw interruption(current) }
        if let deadline, now >= deadline { throw UseError("action_timeout", "The bounded action time expired. Inspect the receipt before doing anything else.", next: "observe") }
    }
    private func observe(_ id: String, image: Bool, elements: String) async throws -> [[String: Any]] {
        // Like a state requery after interruption: a timer alone never restarts input.
        // Only a new observation request can recover an existing approved session.
        let interrupted = try current(id, allowPaused: true)
        if interrupted.paused && interrupted.recoverableInterruption {
            guard interrupted.interactionDeadline.map({ now >= $0 }) ?? true else {
                throw UseError("user_interacting", "The person is still interacting. Wait one second, then observe again. Do not send actions.", next: "wait_then_observe")
            }
            await resume()
        }
        // Retry only read-only capture races. Never repeat an action or cross takeover.
        let generation = try current(id).generation
        session?.needsRefresh = true
        controls.update("Refreshing the approved window before continuing…", paused: false)
        for attempt in 0..<3 {
            guard try current(id).generation == generation else {
                throw UseError("session_changed", "Control changed during refresh.", next: "human_takeover")
            }
            do { return try await observeAttempt(id, image: image, elements: elements) }
            catch let error as UseError {
                guard error.code == "stale_observation", attempt < 2 else { throw error }
                try await Task.sleep(nanoseconds: 75_000_000)
            }
        }
        throw UseError("stale_observation", "The window is still changing. Observe again.", next: "observe")
    }
    private func observeAttempt(_ id: String, image: Bool, elements filter: String) async throws -> [[String: Any]] {
        let current = try current(id)
        session?.observation = nil; session?.records = []; session?.focus = nil
        let bounds = try access.validate(current.target, app: current.app)
        @MainActor func check() throws { try self.checkActive(current) }
        var state = try await access.read(current.target, check: check)
        var png: Data?
        var imageFailure: UseError?
        var width = max(1, Int(bounds.width)); var height = max(1, Int(bounds.height))
        if image {
            do {
                let captured = try await access.capture(target: current.target, app: current.app, bounds: bounds, state: state, check: check)
                png = captured.0; width = captured.1; height = captured.2
            } catch {
                try check()
                let failure = (error as? UseError) ?? UseError("capture_failed", "The window screenshot is unavailable; only the accessible text was read.", next: "observe")
                if failure.code == "stale_observation", policy == .desktop { throw failure }
                imageFailure = failure
                if failure.code == "stale_observation" { state = try await access.read(current.target, check: check) }
            }
        } else if policy == .desktop {
            let after = try await access.read(current.target, check: check)
            guard try access.captureDigest(state) == access.captureDigest(after) else {
                throw UseError("stale_observation", "The window changed during the read. Observe again.", next: "observe")
            }
        }
        try check()
        guard try access.validate(current.target, app: current.app) == bounds else {
            throw UseError("stale_observation", "The window moved during the observation.", next: "observe")
        }
        var effectiveFilter = filter
        var shown = filter == "none" ? [] : filter == "all" ? state.records : state.records.filter(\.interactive)
        if png == nil, shown.isEmpty, filter == "interactive" { shown = state.records; effectiveFilter = "all" }
        guard png != nil || !shown.isEmpty else {
            controls.markPreviewUnavailable()
            throw imageFailure ?? UseError("observation_unavailable", "No image or useful accessible elements could be read.", next: "observe")
        }
        let elements = try shown.map { try $0.payload(bounds: bounds, width: width, height: height, compact: policy == .coworker) }
        let observation = ObservationLease(id: UUID().uuidString.lowercased(), createdAt: now, generation: current.generation,
            frame: bounds, imageWidth: width, imageHeight: height, stateDigest: try access.captureDigest(state),
            imageDigest: png.map(access.imageDigest), validFor: policy.observationSeconds)
        try check()
        session?.observation = observation; session?.records = state.records; session?.focus = state.focusRecord
        session?.lastUsed = now; session?.needsRefresh = false
        if let png { controls.preview(png) }
        else if imageFailure != nil { controls.markPreviewUnavailable() }
        controls.update("Window observed. Ready for the next action.", paused: false)
        var imageInfo: [String: Any] = ["width": width, "height": height, "included": png != nil, "coordinate_space": "image_pixels"]
        if let imageFailure { imageInfo["unavailable"] = imageFailure.payload }
        var payload: [String: Any] = ["ok": true, "session_id": id, "observation_id": observation.id, "window_id": Int(current.target.id),
            "window_title": current.target.title, "mode": current.mode.rawValue, "image": imageInfo, "elements": elements,
            "truncated": state.truncated, "protected_fields": state.protectedFrames.count,
            "content_trust": "untrusted_app_content", "next": "act_once_then_observe"]
        if policy == .coworker {
            payload["elements_filter"] = effectiveFilter; payload["elements_total"] = state.records.count
            payload["observation_seconds"] = Int(policy.observationSeconds)
            if let focus = state.focusRecord { payload["focused_ref"] = focus.ref }
            if let issue = state.privacyIssue { payload["privacy_issue"] = issue }
        }
        var result: [[String: Any]] = []
        if let png { result.append(["type": "image", "data": png.base64EncodedString(), "mimeType": "image/png"]) }
        return result + text(payload)
    }

    private func act(id: String, observationID: String, requestID: String, actions: [Action], raw: Any) async throws -> [[String: Any]] {
        let cached = try current(id, allowPaused: true)
        let fingerprint = try JSONSerialization.data(withJSONObject: ["observation_id": observationID, "action": raw], options: [.sortedKeys])
        if let receipt = cached.receipts[requestID] {
            guard cached.receiptInputs[requestID] == fingerprint else { throw UseError("request_id_reused", "A request_id cannot name a different action.") }
            return text(receipt)
        }
        let current = try current(id)
        guard current.mode != .observe, !actions.contains(where: \.requiresControl) || current.mode == .control else {
            throw UseError("scope_denied", "This action is outside the approved mode. Close the session and ask for the needed scope.", next: "open_session")
        }
        guard current.actionCount + actions.count <= 200 else { close(); throw UseError("action_limit", "The session reached its action limit.", next: "human_takeover") }
        guard let observation = current.observation else { throw UseError("observation_required", "Observe this window before acting. Each observation authorizes one act call.", next: "observe") }
        let bounds = try access.validate(current.target, app: current.app, requireFrontmost: current.mode == .control)
        try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
        if actions.contains(where: \.usesCoordinates), observation.imageDigest == nil {
            throw UseError("image_required", "Coordinates require an observation with an available verified image. Use accessible refs instead.", next: "observe")
        }
        session?.observation = nil; session?.focus = nil; session?.lastUsed = now
        session?.receiptInputs[requestID] = fingerprint
        session?.receipts[requestID] = ["ok": false, "code": "action_interrupted", "request_id": requestID, "next": "observe"]
        let deadline = now + 30
        @MainActor func check() throws { try self.checkActive(current, deadline: deadline) }
        @MainActor func checkWindow() throws {
            try check()
            guard try self.access.validate(current.target, app: current.app, requireFrontmost: current.mode == .control) == bounds else {
                throw UseError("stale_observation", "The window moved during input.", next: "observe")
            }
        }
        var progress = BatchProgress(actions: actions.map(\.name))
        var focus = current.focus
        var needsObservation = false
        var failure: UseError?
        var uncertain = false
        for (index, action) in actions.enumerated() {
            do {
                try check()
                guard !needsObservation, !action.usesCoordinates || !progress.hasInput else {
                    throw UseError("observation_required", "The preceding step may have changed the view or focus. Observe before executing the remaining steps.", next: "observe")
                }
                try checkWindow()
                try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
                var pointerTarget: AXUIElement?
                if action.usesCoordinates || (policy == .desktop && index == 0) {
                    let live = try await access.read(current.target, check: check)
                    guard try access.captureDigest(live) == observation.stateDigest else {
                        throw UseError("stale_observation", "The observed window content or focus changed.", next: "observe")
                    }
                    if action.usesCoordinates {
                        let captured = try await access.capture(target: current.target, app: current.app, bounds: bounds, state: live, check: check)
                        guard access.imageDigest(captured.0) == observation.imageDigest else {
                            throw UseError("stale_observation", "The window image changed. Observe before coordinate input.", next: "observe")
                        }
                        let point: CGPoint
                        switch action {
                        case .move(let p), .click(let p, _, _), .scroll(let p, _, _): point = p
                        case .drag(let points): point = points[0]
                        default: throw UseError("invalid_arguments", "This action has no coordinates.")
                        }
                        pointerTarget = try access.checkHit(observation.screenPoint(point), target: current.target, app: current.app)
                    }
                }
                if !progress.hasInput, let focus {
                    switch action {
                    case .key, .type: try access.validateRecord(focus, target: current.target)
                    default: break
                    }
                }
                try check()
                try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
                session?.actionCount += 1
                let path = try await input.execute(action, app: current.app, target: current.target, lease: observation,
                    access: access, records: current.records, focus: focus, pointerTarget: pointerTarget,
                    check: check, checkWindow: checkWindow, feedback: { [weak self] feedback in
                        guard let self, self.session?.id == id else { return }
                        self.controls.inputFeedback(feedback)
                    })
                uncertain = path != "waited"
                try check()
                progress.dispatched(path: path); uncertain = false
                controls.showAction(action, observation: observation, records: current.records, policy: policy)
                switch action {
                case .click:
                    focus = current.records.first { record in record.textField && pointerTarget.map { CFEqual($0, record.element) } == true }
                    needsObservation = focus == nil
                case .press(let ref):
                    focus = current.records.first { $0.ref == ref && $0.textField }
                    needsObservation = focus == nil
                case .setValue(let ref, _):
                    if focus?.ref != ref { focus = nil }
                case .move, .scroll, .drag: needsObservation = true
                case .key: needsObservation = action.endsFocusSequence
                default: break
                }
                if policy == .coworker, !needsObservation, action.changesWindow, index + 1 < actions.count {
                    try await Task.sleep(nanoseconds: 50_000_000)
                    try check()
                }
            } catch let interrupted as InputFailure {
                failure = interrupted.cause; uncertain = interrupted.mayHaveActed
                break
            } catch {
                failure = (error as? UseError) ?? UseError("action_interrupted", "Input was interrupted. Inspect the receipt; do not repeat it.", next: "human_takeover")
                break
            }
        }
        if failure == nil {
            do { try check() }
            catch { failure = (error as? UseError) ?? UseError("action_interrupted", "Control ended after dispatch.", next: "human_takeover") }
        }
        let receipt = progress.receipt(requestID: requestID, failure: failure, uncertain: uncertain, detailed: policy == .coworker)
        if session?.id == id { session?.receipts[requestID] = receipt }
        return text(receipt)
    }
    private func next(_ current: Session) -> String {
        guard current.paused else { return "observe" }
        guard current.recoverableInterruption else { return "human_takeover" }
        return phase(current) == "person_interacting" ? "wait_then_observe" : "observe"
    }
    private func phase(_ current: Session) -> String {
        if let deadline = current.interactionDeadline, now < deadline { return "person_interacting" }
        if current.paused { return current.recoverableInterruption ? "requery_required" : "ready_to_continue" }
        return current.needsRefresh ? "refreshing" : "working"
    }
    private func personInteracted() {
        guard session != nil else { return }
        // A manual pause or system interruption cannot be converted into recovery
        // merely by more input. Existing standalone clients retain manual Continue.
        // Embedded Continue lives in another process: its click must not renew
        // the interruption delay of an already manually paused session.
        if (SessionControls.automaticRecovery || SessionControls.embeddedCoworker)
            && session?.paused == true && session?.recoverableInterruption != true && resumingSessionID != session?.id { return }
        // Standalone clients never resume automatically after the quiet period.
        // Retain the next human action, not the temporary interaction message.
        pause(SessionControls.automaticRecovery ? "Waiting for your input to finish…" : "You have control. Click Continue when you are ready.")
        session?.recoverableInterruption = SessionControls.automaticRecovery
        session?.interactionDeadline = now + 1
        controls.update(SessionControls.automaticRecovery ? "Waiting for your input to finish…" : "You have control. Waiting for your input to finish…", paused: true, canContinue: false, recoverable: SessionControls.automaticRecovery)
    }
    func pause(_ reason: String) {
        guard let current = session, !current.paused || current.recoverableInterruption || resumingSessionID == current.id else { return }
        session?.pauseReason = reason
        session?.recoverableInterruption = false
        session?.interactionDeadline = nil
        session?.needsRefresh = true
        session?.paused = true; session?.generation += 1; session?.observation = nil; session?.records = []; session?.focus = nil
        stopWatching()
        input.releaseAll()
        controls.update(reason, paused: true)
    }
    private func resume() async {
        guard let current = session, current.paused, resumingSessionID == nil,
              current.interactionDeadline.map({ now >= $0 }) ?? true else { return }
        resumingSessionID = current.id
        defer { if resumingSessionID == current.id { resumingSessionID = nil } }
        do {
            // Approval, explicit recovery from a blocker, or a state requery after
            // quiet input can enter here. Actions themselves can never resume.
            if current.mode == .control {
                _ = try access.validate(current.target, app: current.app)
                guard AXUIElementPerformAction(current.target.element, kAXRaiseAction as CFString) == .success,
                      current.app.app.activate(options: []) else {
                    throw UseError("window_unavailable", "Open the approved window, then click Continue.", next: "human_takeover")
                }
                // Activation is asynchronous. Request it once and wait briefly, without
                // repeatedly stealing focus if the person changes their mind.
                for attempt in 0..<10 {
                    guard session?.id == current.id, session?.generation == current.generation else { return }
                    if (try? access.validate(current.target, app: current.app, requireFrontmost: true)) != nil { break }
                    if attempt < 9 { try await Task.sleep(nanoseconds: 50_000_000) }
                }
            }
            guard session?.id == current.id, session?.generation == current.generation else { return }
            _ = try access.validate(current.target, app: current.app, requireFrontmost: current.mode == .control)
            expire(); guard session != nil else { return }
            session?.pauseReason = nil
            session?.recoverableInterruption = false
            session?.interactionDeadline = nil
            session?.needsRefresh = true
            session?.paused = false; session?.generation += 1; session?.observation = nil; session?.lastUsed = now
            controls.update("Refreshing the approved window before continuing…", paused: false)
        } catch {
            guard session?.id == current.id, session?.generation == current.generation else { return }
            session?.pauseReason = error.localizedDescription
            session?.recoverableInterruption = false
            session?.interactionDeadline = nil
            controls.update(error.localizedDescription, paused: true)
        }
    }
    private func expire() {
        guard let current = session else { return }
        if let deadline = current.interactionDeadline, now >= deadline {
            session?.interactionDeadline = nil
            controls.update(current.recoverableInterruption ? "Waiting for a fresh view before continuing…" : current.pauseReason ?? "You have control. Click Continue when you are ready.", paused: true, recoverable: current.recoverableInterruption)
        }
        controls.updateExpiry(seconds: max(0, Int(900 - (now - current.started))))
        if now - current.started >= 900 || current.app.app.isTerminated { close(); return }
        if !current.paused && now - current.lastUsed >= 120 { pause("Paused after two minutes without activity.") }
    }
    func close() {
        stopWatching()
        resumingSessionID = nil; session = nil
        input.releaseAll(); lease = nil; controls.close()
    }
    func cancel() {
        controls.cancelConsent()
        // Cancellation is terminal, including an idle agent turn's pending call.
        close()
    }
    private func text(_ payload: [String: Any]) -> [[String: Any]] {
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return [["type": "text", "text": String(decoding: data, as: UTF8.self)]]
    }
}
