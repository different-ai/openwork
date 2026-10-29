import AppKit
import ApplicationServices

@MainActor
final class SessionRuntime {
    private let access = MacAccessibility()
    private let input = MacInput()
    private let controls = SessionControls()
    private let policy: RuntimePolicy
    private let clock: () -> TimeInterval
    private var session: Session?
    private var lease: ControlLease?
    private var busy = false
    private var desktopAvailable = true
    private var resumingSessionID: String?
    private var watch = WatchLease()
    private var watchTimer: Timer?
    private var watchCapture: Task<Void, Never>?
    private var lastWatchCaptureAt: TimeInterval = -.infinity
    private var handBack = SharedDesktop.HandBack()
    private var handBackTimer: Timer?
    private let backgroundDelivery = ProcessInfo.processInfo.environment[InputDelivery.hostVariable] == InputDelivery.background.rawValue

    private struct Session {
        let id: String
        /// What observations and input work in: the session's window, or a dialog over it.
        var app: AppIdentity
        var target: WindowTarget
        let mode: AccessMode
        /// Background until the app shows it needs the front for keys.
        var delivery: InputDelivery
        /// The windows under the dialogs being worked in, the session's own first.
        var parents: [(app: AppIdentity, target: WindowTarget, kind: DialogTarget.Kind?)] = []
        /// Windows the last action opened: the only new windows a session follows.
        var openedByLastAction: Set<CGWindowID> = []
        var dialogKind: DialogTarget.Kind?
        /// A dialog closed since the last observation and the session is back in its window.
        var returnedFromDialog = false
        /// The file panel the person let the agent look through.
        var filePanelAllowed: CGWindowID?
        /// Control input that brings the window to the front first. Dialogs always take it.
        var takesFront: Bool { mode == .control && (delivery == .foreground || !parents.isEmpty) }
        /// The window that comes forward, and whose app must be in front: a dialog's parent.
        var frontApp: AppIdentity { parents.first?.app ?? app }
        var frontTarget: WindowTarget { parents.first?.target ?? target }
        /// Whether input requires `target` itself to be the front window; a dialog is
        /// not a window of the front app (the file panel is another process).
        var checksFront: Bool { takesFront && parents.isEmpty }
        var started: TimeInterval
        var lastUsed: TimeInterval
        var generation = 0
        var paused = false
        var pauseReason: String?
        var interactionDeadline: TimeInterval?
        var needsRefresh = true
        let purpose: String
        var observation: ObservationLease?
        var records: [ElementRecord] = []
        var actionCount = 0
        var receipts: [String: [String: Any]] = [:]
        var receiptInputs: [String: Data] = [:]
        var focus: ElementRecord?
        var baseline: ActionBaseline?
        /// The person interrupted the last step; the read right after it leaves the front to them.
        var yielded = false
    }
    init(policy: RuntimePolicy = .desktop, clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.policy = policy; self.clock = clock
        controls.onPause = { [weak self] reason in self?.pause(reason) }
        controls.onAvailability = { [weak self] available in self?.desktopAvailability(available) }
        controls.onResume = { [weak self] in Task { await self?.resume() } }
        controls.onStop = { [weak self] in self?.close(stoppedByPerson: true) }
        controls.onTick = { [weak self] in self?.expire() }
        controls.onWatch = { [weak self] visible in self?.watchWindow(visible: visible) }
    }
    private var now: TimeInterval { clock() }

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
        handBackTimer?.invalidate(); handBackTimer = nil
        busy = true; defer { busy = false; scheduleHandBack() }
        switch name {
        case "computer_discover":
            try a.only([])
            return text(discover())
        case "computer_open_session":
            try a.only(["app_id", "pid", "window_id", "mode", "purpose"])
            guard session == nil else { throw UseError("session_exists", "Close this connection's session before opening another.", next: "close_session") }
            defer { if session == nil { controls.close() } }
            let appID = try a.string("app_id")
            let pid = values["pid"] == nil ? nil : pid_t(try a.integer("pid", min: 1, max: Int(Int32.max)))
            guard let mode = AccessMode(rawValue: try a.string("mode")) else { throw UseError("invalid_arguments", "mode must be observe, assist, or control.") }
            let purpose = try a.string("purpose", max: 500)
            try access.requirePermissions()
            // Decided before launch, so a background session never activates the app.
            let installed = NSRunningApplication.runningApplications(withBundleIdentifier: appID).first?.bundleURL
                ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: appID)
            let frameworks = installed.map { (try? FileManager.default.contentsOfDirectory(atPath: $0.appendingPathComponent("Contents/Frameworks").path)) ?? [] } ?? []
            let delivery = InputDelivery.decide(enabled: backgroundDelivery, available: BackgroundFocus.available, mode: mode, bundleID: appID,
                info: installed.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:], frameworks: frameworks)
            let background = delivery == .background
            let identity = try await AppIdentity.open(appID, pid: pid, activates: !background)
            var windows = try await access.windows(identity)
            if windows.isEmpty {
                // Reopen a running app's normal window through Launch Services.
                // Resolve the opened app before reading or dispatching input.
                if let url = identity.app.bundleURL {
                    let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = !background
                    _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
                    windows = try await access.windows(identity)
                }
            }
            guard !windows.isEmpty else { throw UseError("window_unavailable", "The app opened, but did not expose a usable window. Check for a sign-in or app dialog, then request a session again.", next: "human_takeover") }
            try Task.checkCancellation()
            let requested = values["window_id"] == nil ? nil : try a.integer("window_id", min: 1, max: Int(UInt32.max))
            let focusedID = access.focusedWindowID(identity, windows: windows, requireActive: !background)
            let targetID = try WindowSelection.resolve(ids: windows.map { Int($0.id) }, requested: requested, focused: focusedID,
                descriptions: windows.map { "\($0.id): \($0.title)" })
            guard let target = windows.first(where: { Int($0.id) == targetID }) else { throw UseError("window_unavailable", "The resolved window closed.", next: "open_session") }
            try Task.checkCancellation()
            _ = try access.validate(target, app: identity)
            let reservation = try ControlLease(pid: identity.pid, window: target.id)
            let id = UUID().uuidString.lowercased()
            session = Session(id: id, app: identity, target: target, mode: mode, delivery: delivery, started: now, lastUsed: now, purpose: purpose)
            lease = reservation
            controls.show(app: identity, target: target, mode: mode, purpose: purpose, background: background)
            if mode == .control, !background, let current = session {
                // Initial focus is technical startup, never a human pause/Continue flow.
                let focus = try await FocusLease.acquire(check: { try self.checkActive(current) })
                defer { focus.release() }
                let keys = try await FocusLease.acquire(app: current.app.pid, check: { try self.checkActive(current) })
                defer { keys.release() }
                try await takeGap(current)
                do { try await takeFront(current) }
                catch let error as UseError where error.code == SharedDesktop.interrupted.code {
                    // Nothing stays half open: the host opens the session again later.
                    close()
                    throw error
                }
            }
            guard let opened = session, opened.id == id else { throw UseError("session_unavailable", "Access ended while starting. Stop work and wait for a new user request.", next: "human_takeover") }
            return text(["ok": true, "session_id": id, "app_id": identity.bundleID, "app_name": identity.name, "pid": Int(identity.pid),
                "window_id": Int(target.id), "window_title": target.title, "mode": mode.rawValue, "delivery": delivery.rawValue,
                "state": opened.paused ? "paused" : "active", "expires_in_seconds": 900,
                "next": next(opened)])
        case "computer_observe":
            let options = try ObservationOptions(values, policy: policy)
            return try await observe(try a.string("session_id"), image: options.image, elements: options.elements,
                filePanelAccess: policy == .embedded ? (values["file_panel_access"] as? NSNumber)?.uint32Value : nil)
        case "computer_act":
            try a.only(policy == .embedded ? ["session_id", "observation_id", "request_id", "action", "actions", "intent", "file_approval", "file_panel_access"] : ["session_id", "observation_id", "request_id", "action"])
            let id = try a.string("session_id")
            let observationID = try a.string("observation_id")
            let requestID = try a.string("request_id", max: 100)
            let actions = try Action.batch(values, policy: policy)
            let raw = values["actions"] ?? values["action"] ?? NSNull()
            // Display only: shown on the person's desktop cursor, never part of the receipt identity.
            let intent = values["intent"] == nil ? nil : try a.string("intent", max: 120)
            // Set only by the trusted host: the exact names the person approved handing over,
            // and whether they let the agent look through a file panel at all.
            let fileApproval = policy == .embedded ? values["file_approval"] as? [String] : nil
            // The panel the person allowed, by its window: never whichever panel is open now.
            let panelAccess = policy == .embedded ? (values["file_panel_access"] as? NSNumber)?.uint32Value : nil
            return try await act(id: id, observationID: observationID, requestID: requestID, actions: actions, raw: raw, intent: intent,
                fileApproval: fileApproval, filePanelAccess: panelAccess)
        case "computer_zoom" where policy == .embedded:
            try a.only(["session_id", "observation_id", "x", "y", "width", "height"])
            return try await zoom(try a.string("session_id"), observationID: try a.string("observation_id"),
                region: CGRect(x: try a.number("x", min: 0, max: 100_000), y: try a.number("y", min: 0, max: 100_000),
                               width: try a.number("width", min: 8, max: 100_000), height: try a.number("height", min: 8, max: 100_000)))
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
        var limits = ["lease_seconds": 900, "observation_seconds": Int(policy.observationSeconds), "actions_per_lease": 200]
        var result: [String: Any] = ["ok": true, "protocol": "openwork.computer-use/1", "platform": "macos",
            "permissions": Self.permissions(), "apps": apps,
            "modes": AccessMode.allCases.map { ["id": $0.rawValue, "description": $0.explanation] },
            "keys": policy.keys, "guidance": policy.guidance]
        if policy == .embedded {
            limits["batch_actions"] = Action.batchLimit
            result["modifiers"] = NativeKey.supportedModifiers
            result["shortcuts"] = NativeKey.shortcuts.sorted()
            result["blocked_shortcuts"] = NativeKey.blockedShortcuts
        }
        result["limits"] = limits
        return result
    }
    private func watchWindow(visible: Bool) {
        guard SessionControls.embedded, session != nil else { return }
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
        if !desktopAvailable && !allowPaused { throw UseError("desktop_unavailable", "The desktop is temporarily unavailable. Wait until it is available, then observe again.", next: "observe") }
        try Task.checkCancellation()
        try current.app.validate()
        return current
    }
    private func interruption(_ current: Session) -> UseError {
        if policy == .embedded {
            // Say why it paused and where Continue is, so the model can tell the person in one sentence.
            let reason = current.pauseReason.map { " (\($0))" } ?? ""
            return UseError("session_paused", "Paused for the person\(reason). They resume with Continue on your pill over the selected window or in OpenWork's Computer view. Tell them that once and stop; do not retry automatically.", next: "human_takeover")
        }
        return UseError("session_paused", "The person must choose Continue in the Computer Use controls. Do not retry automatically.", next: "human_takeover")
    }
    private func checkActive(_ expected: Session, deadline: TimeInterval? = nil) throws {
        try Task.checkCancellation()
        guard let current = session, current.id == expected.id else {
            throw UseError("session_changed", "Access ended during this operation. No remaining input is allowed.", next: "human_takeover")
        }
        if current.paused { throw interruption(current) }
        if !desktopAvailable { throw UseError("desktop_unavailable", "The desktop became unavailable. No remaining input is allowed; observe again when available.", next: "observe") }
        guard current.generation == expected.generation else {
            throw UseError("session_changed", "Control changed during this operation. A new observation is required.", next: "human_takeover")
        }
        if let deadline, now >= deadline { throw UseError("action_timeout", "The bounded action time expired. Inspect the receipt before doing anything else.", next: "observe") }
    }
    /// A macOS prompt only the person may answer is open; the agent waits for them.
    private func personNeeded(_ prompt: (reason: String, app: String)) -> [[String: Any]] {
        text(["ok": false, "code": "person_needed", "reason": prompt.reason, "prompt_app": prompt.app, "dispatched": false,
              "next": "human_takeover", "message": HandoverRules.message(prompt.reason)])
    }
    /// A file panel lists the person's files: nothing of it reaches the agent until they allow it.
    private func filePanelAccessRequired(_ current: Session) -> [[String: Any]] {
        text(["ok": false, "code": "file_panel_approval_required", "app": current.frontApp.name, "panel_id": Int(current.target.id), "dispatched": false, "next": "observe",
              "message": "A file panel opened. The person is asked before the agent sees their files; nothing was read."])
    }
    private func observe(_ id: String, image: Bool?, elements: String, filePanelAccess: CGWindowID? = nil) async throws -> [[String: Any]] {
        // A paused session never resumes from an observation: only the person's Continue does.
        // Retry only read-only capture races. Never repeat an action or cross takeover.
        try await followDialog(id)
        if let prompt = access.personPrompt() { return personNeeded(prompt) }
        let current = try current(id)
        if current.dialogKind == .filePanel, current.filePanelAllowed != current.target.id {
            guard filePanelAccess == current.target.id else { return filePanelAccessRequired(current) }
            // Allowed for this panel until it closes; another panel asks again.
            session?.filePanelAllowed = current.target.id
        }
        session?.needsRefresh = true
        controls.update("Refreshing the selected window before continuing…", paused: false)
        // A foreground observation shows the window in front, as input will see it.
        // Background reads the window where it is: capture works behind other windows.
        let focus = current.takesFront ? try await FocusLease.acquire(check: { try self.checkActive(current) }) : nil
        defer { focus?.release() }
        // Bringing the window forward makes it the app's key window: not while another
        // agent in this app is between selecting its own window and typing.
        let keys = current.takesFront ? try await FocusLease.acquire(app: current.frontApp.pid, check: { try self.checkActive(current) }) : nil
        defer { keys?.release() }
        // In the background, another focused window of the app is the same signal as
        // another window in front: usually a dialog the last action opened.
        var otherWindowFocused = current.mode == .control && current.delivery == .background && current.parents.isEmpty
            && access.focusesAnotherWindow(than: current.target, app: current.app)
        var returns = 0
        // Something else in front is the person or another app, not a takeover:
        // bring the selected window back for this read; it is handed back after.
        func bringBack() async throws {
            guard current.takesFront else { return }
            // Right after the person interrupted a step, read without taking the front.
            // The next action takes it and re-checks the window against this read.
            if self.session?.yielded == true {
                self.session?.yielded = false
                otherWindowFocused = true
                return
            }
            try await self.takeGap(current)
            guard !self.inFront(current) else { return }
            // Another window of this app in front is usually a dialog the last action
            // opened. Raising the target would hide it, or fail behind a modal one;
            // input raises the target only when the model acts on it again.
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == current.app.pid {
                otherWindowFocused = true
                return
            }
            _ = try await SharedDesktop.returnFocus(used: &returns, inFront: { false }, focus: { try await self.takeFront(current) })
        }
        return try await ObservationPreparation.capture(mode: current.mode, check: {
            try self.checkActive(current)
        }, focus: bringBack, read: {
            for attempt in 0..<3 {
                try self.checkActive(current)
                do { return try await self.observeAttempt(id, image: image, elements: elements, otherWindowFocused: otherWindowFocused) }
                catch let error as UseError {
                    if error.code == "window_not_frontmost", current.checksFront, attempt < 2 {
                        try await bringBack()
                        continue
                    }
                    guard error.code == "stale_observation", attempt < 2 else { throw SharedDesktop.yielding(error) }
                    try await Task.sleep(nanoseconds: 75_000_000)
                }
            }
            throw UseError("stale_observation", "The window is still changing. Observe again.", next: "observe")
        })
    }
    private func observeAttempt(_ id: String, image requested: Bool?, elements filter: String, otherWindowFocused: Bool = false) async throws -> [[String: Any]] {
        let current = try current(id)
        session?.observation = nil; session?.records = []; session?.focus = nil
        let frontmost = current.checksFront && !otherWindowFocused
        let bounds = try access.validate(current.target, app: current.app, requireFrontmost: frontmost)
        @MainActor func check() throws { try self.checkActive(current) }
        var state = try await access.read(current.target, check: check)
        var png: Data?
        var imageFailure: UseError?
        var width = max(1, Int(bounds.width)); var height = max(1, Int(bounds.height))
        let namedControls = state.records.filter { bounds.contains($0.frame) && $0.interactive && !$0.label.isEmpty }.count
        let image = ImagePolicy.include(requested: requested, automatic: current.delivery == .background, namedControls: namedControls)
        if image {
            do {
                let captured = try await observationImage(current, bounds: bounds, state: state, requireFrontmost: frontmost, check: check)
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
        guard try access.validate(current.target, app: current.app, requireFrontmost: frontmost) == bounds else {
            throw UseError("stale_observation", "The window moved during the observation.", next: "observe")
        }
        var effectiveFilter = filter
        // AX trees can retain virtualized or scrolled-out nodes. Keep those
        // internal for privacy/staleness scans, never expose their text or refs.
        let visible = state.records.filter { bounds.contains($0.frame) }
        var shown = filter == "none" ? [] : filter == "all" ? visible : visible.filter(\.interactive)
        if png == nil, shown.isEmpty, filter == "interactive" { shown = visible; effectiveFilter = "all" }
        guard png != nil || !shown.isEmpty else {
            throw imageFailure ?? UseError("observation_unavailable", "No image or useful accessible elements could be read.", next: "observe")
        }
        let elements = try shown.map { try $0.payload(bounds: bounds, width: width, height: height, compact: policy == .embedded) }
        let observation = ObservationLease(id: UUID().uuidString.lowercased(), createdAt: now, generation: current.generation,
            frame: bounds, imageWidth: width, imageHeight: height, stateDigest: try access.captureDigest(state),
            imageDigest: png.map(access.imageDigest), validFor: policy.observationSeconds)
        try check()
        let observedFocus = state.focusRecord.flatMap { focus in shown.first { CFEqual($0.element, focus.element) } }
        let afterAction = current.baseline.flatMap { baseline in
            baseline.generation == current.generation ? baseline.changes(stateDigest: observation.stateDigest, imageDigest: observation.imageDigest) : nil
        }
        session?.observation = observation; session?.records = shown; session?.focus = observedFocus
        session?.lastUsed = now; session?.needsRefresh = false; session?.baseline = nil
        controls.update("Window observed. Ready for the next action.", paused: false)
        var imageInfo: [String: Any] = ["width": width, "height": height, "included": png != nil, "coordinate_space": "image_pixels"]
        if let imageFailure { imageInfo["unavailable"] = imageFailure.payload }
        if !image { imageInfo["omitted"] = requested == false ? "requested" : "accessible_controls_suffice" }
        var payload: [String: Any] = ["ok": true, "session_id": id, "observation_id": observation.id, "window_id": Int(current.target.id),
            "window_title": current.target.title, "mode": current.mode.rawValue, "image": imageInfo, "elements": elements,
            "truncated": state.truncated, "protected_fields": state.protectedFrames.count,
            "content_trust": "untrusted_app_content", "next": "act_once_then_observe"]
        if let afterAction { payload["after_action"] = afterAction }
        if otherWindowFocused { payload["other_window_focused"] = true }
        if let kind = current.dialogKind {
            // Elements and coordinates are the dialog's; it is worked in until it closes.
            payload["dialog"] = ["kind": kind.rawValue, "title": current.target.title, "depth": current.parents.count]
        }
        if current.returnedFromDialog { payload["dialog_closed"] = true; session?.returnedFromDialog = false }
        if policy == .embedded {
            payload["elements_filter"] = effectiveFilter; payload["elements_total"] = visible.count
            payload["observation_seconds"] = Int(policy.observationSeconds)
            if let focus = observedFocus { payload["focused_ref"] = focus.ref }
            if let issue = state.privacyIssue { payload["privacy_issue"] = issue }
        }
        var result: [[String: Any]] = []
        if let png { result.append(["type": "image", "data": png.base64EncodedString(), "mimeType": Self.observationMimeType]) }
        return result + text(payload)
    }

    /// Observations are compact JPEGs: image tokens and upload time dominate each step.
    /// The re-capture that guards coordinate input uses the same encoding, so digests compare.
    static let observationMimeType = "image/jpeg"
    private func observationImage(_ current: Session, bounds: CGRect, state: WindowState, requireFrontmost: Bool,
                                  check: () throws -> Void) async throws -> (Data, Int, Int, Int64) {
        try await access.capture(target: current.target, app: current.app, bounds: bounds, state: state,
            maxLongSide: 1280, jpegQuality: 0.8, requireFrontmost: requireFrontmost, check: check)
    }

    /// A sharper look at part of the current observation, for reading only. It
    /// neither consumes nor replaces the observation, so coordinates stay in the
    /// original image's pixels and the next act still uses that observation_id.
    private func zoom(_ id: String, observationID: String, region pixels: CGRect) async throws -> [[String: Any]] {
        let current = try current(id)
        guard let observation = current.observation else { throw UseError("observation_required", "Observe this window before zooming.", next: "observe") }
        let bounds = try access.validate(current.target, app: current.app)
        try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
        guard observation.imageWidth > 0, observation.imageHeight > 0,
              CGRect(x: 0, y: 0, width: observation.imageWidth, height: observation.imageHeight).contains(pixels) else {
            throw UseError("invalid_arguments", "The zoom region must lie inside the observation image.", next: "observe")
        }
        let xScale = bounds.width / CGFloat(observation.imageWidth), yScale = bounds.height / CGFloat(observation.imageHeight)
        let region = CGRect(x: pixels.minX * xScale, y: pixels.minY * yScale, width: pixels.width * xScale, height: pixels.height * yScale)
        @MainActor func check() throws { try self.checkActive(current) }
        let state = try await access.read(current.target, check: check)
        let (png, width, height, capturedAt) = try await access.capture(target: current.target, app: current.app, bounds: bounds, state: state,
            region: region, maxScale: NSScreen.screens.map(\.backingScaleFactor).max() ?? 2, check: check)
        try check()
        session?.lastUsed = now
        let payload: [String: Any] = ["ok": true, "session_id": id, "observation_id": observationID, "state": "active",
            "region": ["x": pixels.minX, "y": pixels.minY, "width": pixels.width, "height": pixels.height, "coordinate_space": "image_pixels"],
            "image": ["width": width, "height": height, "captured_at": capturedAt], "protected_fields": state.protectedFrames.count,
            "content_trust": "untrusted_app_content",
            "next": "Read only. Act with the same observation_id and coordinates from the original observation image, not this zoom."]
        return [["type": "image", "data": png.base64EncodedString(), "mimeType": "image/png"]] + text(payload)
    }

    private func act(id: String, observationID: String, requestID: String, actions: [Action], raw: Any, intent: String? = nil,
                     fileApproval: [String]? = nil, filePanelAccess: CGWindowID? = nil) async throws -> [[String: Any]] {
        let cached = try current(id, allowPaused: true)
        let fingerprint = try JSONSerialization.data(withJSONObject: ["observation_id": observationID, "action": raw], options: [.sortedKeys])
        if let receipt = cached.receipts[requestID] {
            guard cached.receiptInputs[requestID] == fingerprint else { throw UseError("request_id_reused", "A request_id cannot name a different action.") }
            return text(receipt)
        }
        // A dialog opened or closed since the last look: its controls are not the observed ones.
        if try await followDialog(id) {
            throw UseError("observation_required", "A dialog opened or closed since the last observation. Observe again; nothing was sent.", next: "observe")
        }
        if let prompt = access.personPrompt() { return personNeeded(prompt) }
        let current = try current(id)
        if current.dialogKind == .filePanel, current.filePanelAllowed != current.target.id {
            guard filePanelAccess == current.target.id else { return filePanelAccessRequired(current) }
            // Allowed for this panel until it closes; another panel asks again.
            session?.filePanelAllowed = current.target.id
        }
        guard current.mode != .observe, !actions.contains(where: \.requiresControl) || current.mode == .control else {
            throw UseError("scope_denied", "This action is outside the selected mode. Close the session and open the needed mode.", next: "open_session")
        }
        if current.actionCount + actions.count > 200 { session?.actionCount = 0 }
        if current.receipts.count >= 200, let oldest = current.receipts.keys.first {
            session?.receipts.removeValue(forKey: oldest); session?.receiptInputs.removeValue(forKey: oldest)
        }
        guard let observation = current.observation else { throw UseError("observation_required", "Observe this window before acting. Each observation authorizes one act call.", next: "observe") }
        let desktopBefore = DesktopState.now()
        // In the background the person keeps the front, unless a step in this batch
        // only works while the app is active or follows the real pointer.
        let route = input.route(for: current.app)
        let inBackground = current.mode == .control && current.delivery == .background && current.parents.isEmpty
        let front = current.takesFront || inBackground && actions.contains { InputDelivery.stepNeedsFront($0, route: route) }
        // Whether `target` itself must be the front window: never for a dialog.
        let frontCheck = front && current.parents.isEmpty
        let background = inBackground && !front
        // Held through the settle wait, so no other agent's window comes forward mid-batch.
        let focusLease = front ? try await FocusLease.acquire(check: { try self.checkActive(current) }) : nil
        defer { focusLease?.release() }
        // Every control step may change the app's key window, and keys go to that window:
        // agents in other windows of this app wait until this batch's input is sent.
        let keyLease = front || background ? try await FocusLease.acquire(app: current.frontApp.pid, check: { try self.checkActive(current) }) : nil
        defer { keyLease?.release() }
        // The person may be using another app meanwhile; bring the selected window back
        // for this step instead of pausing when they switched away. A click or key of
        // theirs from here on stops the step and leaves the computer to them.
        try await takeGap(current, front: front)
        let moment = ProcessInfo.processInfo.systemUptime
        var returns = 0
        var disturbed = try await shareDesktop(current, returns: &returns, since: moment, front: front)
        // The observation showed the window behind other work; coordinates need a fresh look.
        if inBackground, front, disturbed, actions.contains(where: \.usesCoordinates) {
            throw UseError("observation_required", "This step needs the app in front, so its window was brought forward. Observe again, then repeat the step; nothing was sent.", next: "observe")
        }
        let bounds: CGRect
        do { bounds = try access.validate(current.target, app: current.app, requireFrontmost: frontCheck) }
        catch { throw SharedDesktop.yielding(error) }
        try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
        if actions.contains(where: \.usesCoordinates), observation.imageDigest == nil {
            throw UseError("image_required", "Coordinates require an observation with an image. Use accessible refs, or observe with include_image true.", next: "observe")
        }
        // Confirming a file panel hands the chosen files to the app, which can upload them:
        // the person approves first. Nothing is sent and the observation stays valid.
        if current.dialogKind == .filePanel, confirmsFilePanel(current, observation: observation, actions: actions) {
            let names = access.selectedFileNames(current.target)
            // The confirmation is its own step, so nothing in the batch changes the selection after it is read.
            guard actions.count == 1 else {
                throw UseError("confirm_alone", "Confirm a file panel as its own step, after the selection is final. Nothing was sent.", next: "observe")
            }
            guard !names.isEmpty else {
                throw UseError("file_selection_unreadable", "The panel's selection could not be read, so it cannot be shown to the person. Ask them to choose the files. Nothing was sent.", next: "human_takeover")
            }
            guard names.count <= DialogRules.maxApprovedFiles else {
                throw UseError("too_many_files", "Choose at most \(DialogRules.maxApprovedFiles) files at a time. Nothing was sent.", next: "observe")
            }
            // Exactly the files the person approved, read again right before the press.
            // Every selected name, duplicates and order included: same-named files are each counted.
            guard let fileApproval, fileApproval == names else {
                return text(["ok": false, "code": "files_approval_required", "files": names,
                    "app": current.frontApp.name, "dispatched": false, "next": "observe",
                    "message": "Choosing files hands them to the app. The person is asked first; nothing was sent."])
            }
        }
        session?.observation = nil; session?.focus = nil; session?.lastUsed = now
        if let intent { controls.narrate(intent) }
        session?.receiptInputs[requestID] = fingerprint
        session?.receipts[requestID] = ["ok": false, "code": "action_interrupted", "request_id": requestID, "next": "observe"]
        let deadline = now + 30
        @MainActor func check() throws { try self.checkActive(current, deadline: deadline) }
        @MainActor func checkWindow() throws {
            try check()
            let live: CGRect
            do { live = try self.access.validate(current.target, app: current.app, requireFrontmost: frontCheck) }
            catch { throw SharedDesktop.yielding(error) }
            guard live == bounds else {
                throw UseError("stale_observation", "The window moved during input.", next: "observe")
            }
        }
        @MainActor func checkInput() throws {
            try check()
            guard current.mode == .control, self.personInterrupted(since: moment) else { return }
            // In the background the person's input goes to their own front app; it
            // stops the step only once they are working in the agent's app.
            if front || NSWorkspace.shared.frontmostApplication?.processIdentifier == current.frontApp.pid {
                throw SharedDesktop.interrupted
            }
        }
        var progress = BatchProgress(actions: actions.map(\.name))
        // Watch for the app's reaction from the first event on, so the wait
        // after input ends when the app has finished changing.
        let activity = actions.contains(where: \.changesWindow) ? AXActivity(pid: current.app.pid, clock: clock) : nil
        defer { activity?.stop() }
        let windowsBefore = access.windowChanges(current.app)
        var focus = current.focus
        var activated = false
        var primed = false
        var needsObservation = false
        var failure: UseError?
        var uncertain = false
        for (index, action) in actions.enumerated() {
            do {
                try checkInput()
                guard !needsObservation, !action.usesCoordinates || !progress.hasInput else {
                    throw UseError("observation_required", "The preceding step may have changed the view or focus. Observe before executing the remaining steps.", next: "observe")
                }
                // Between steps, bring the window back if something else came to the front.
                // Before any input, the window must still match the observation; after it,
                // each step re-validates the field or control it uses.
                if index > 0, try await shareDesktop(current, returns: &returns, since: moment, deadline: deadline, front: front) { disturbed = true }
                try checkWindow()
                try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
                var pointerTarget: AXUIElement?
                if action.usesCoordinates || (policy == .desktop && index == 0) || (disturbed && !progress.hasInput) {
                    let live = try await access.read(current.target, check: check)
                    guard try access.captureDigest(live) == observation.stateDigest else {
                        throw UseError("stale_observation", "The observed window content or focus changed.", next: "observe")
                    }
                    if action.usesCoordinates {
                        let captured = try await observationImage(current, bounds: bounds, state: live,
                            requireFrontmost: frontCheck, check: check)
                        guard access.imageDigest(captured.0) == observation.imageDigest else {
                            throw UseError("stale_observation", "The window image changed. Observe before coordinate input.", next: "observe")
                        }
                        let point: CGPoint
                        switch action {
                        case .move(let p), .click(let p, _, _), .scroll(let p, _, _): point = p
                        case .drag(let points): point = points[0]
                        default: throw UseError("invalid_arguments", "This action has no coordinates.")
                        }
                        pointerTarget = try access.checkHit(observation.screenPoint(point), target: current.target, app: current.app, background: background || !current.parents.isEmpty)
                    }
                }
                if !progress.hasInput, let focus {
                    switch action {
                    case .key, .type: try access.validateRecord(focus, target: current.target)
                    default: break
                    }
                }
                if background, case .click = action, !activated {
                    // A background click lands like one in an inactive window unless the app
                    // treats the window as active first: one focus record, to the app only.
                    activated = BackgroundFocus.post(pid: current.app.pid, window: current.target.id, makeKey: false)
                    if activated { try await Task.sleep(nanoseconds: UInt64(BackgroundFocus.settle * 1_000_000_000)) }
                }
                if background, action.name == "key" || action.name == "type", !primed {
                    // Keys go to the app's own key window: make it the selected one inside the
                    // app and read it back. Never type into another window of the app.
                    do {
                        try await BackgroundFocus.primeKeys(routes: { self.access.isFocusedWindow(current.target, app: current.app) },
                            post: { BackgroundFocus.post(pid: current.app.pid, window: current.target.id, makeKey: true) }, now: { self.now },
                            check: check, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
                    } catch let error as UseError where error.code == BackgroundFocus.keysUnavailable.code {
                        // This app needs the front for keys: its later steps take it.
                        session?.delivery = .foreground
                        throw error
                    }
                    primed = true
                }
                try check()
                try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
                session?.actionCount += 1
                let path = try await input.execute(action, app: current.app, target: current.target, lease: observation,
                    access: access, records: current.records, focus: focus, pointerTarget: pointerTarget,
                    check: checkInput, checkWindow: checkWindow, background: background || !current.parents.isEmpty, feedback: { [weak self] feedback in
                        guard let self, self.session?.id == id else { return }
                        self.controls.inputFeedback(feedback)
                    })
                uncertain = path != "waited"
                try check()
                progress.dispatched(path: path); uncertain = false
                controls.showAction(action, records: current.records)
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
                if policy == .embedded, !needsObservation, action.changesWindow, index + 1 < actions.count {
                    try await Task.sleep(nanoseconds: 50_000_000)
                    try check()
                }
            } catch let interrupted as InputFailure {
                failure = SharedDesktop.yielding(interrupted.cause); uncertain = interrupted.mayHaveActed
                break
            } catch {
                failure = (SharedDesktop.yielding(error) as? UseError) ?? UseError("action_interrupted", "Input was interrupted. Inspect the receipt; do not repeat it.", next: "human_takeover")
                break
            }
        }
        if failure?.code == SharedDesktop.interrupted.code {
            // The person chose where to be: leave the front with them, and let the read
            // that follows this step happen without taking it again.
            handBack.forget()
            session?.yielded = true
        }
        var settled: Bool?
        if progress.hasInput || uncertain {
            session?.baseline = ActionBaseline(generation: current.generation, stateDigest: observation.stateDigest, imageDigest: observation.imageDigest)
            do {
                settled = try await InputSettle.wait(since: now, lastActivity: { activity?.last ?? 0 }, now: { self.now },
                    check: check, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
            } catch {
                if failure == nil { failure = (error as? UseError) ?? UseError("action_interrupted", "Control ended after dispatch.", next: "human_takeover") }
            }
        }
        if failure == nil {
            do { try check() }
            catch { failure = (error as? UseError) ?? UseError("action_interrupted", "Control ended after dispatch.", next: "human_takeover") }
        }
        var receipt = progress.receipt(requestID: requestID, failure: failure, uncertain: uncertain, detailed: policy == .embedded)
        if let settled { receipt["settled"] = settled }
        let windowsAfter = access.windowChanges(current.app)
        if settled != nil, let changes = windowsBefore.diff(windowsAfter, target: current.target.id) {
            receipt["window_changes"] = changes
        }
        if progress.hasInput { session?.openedByLastAction = windowsAfter.windows.subtracting(windowsBefore.windows) }
        receipt["delivery"] = (background ? InputDelivery.background : .foreground).rawValue
        receipt["desktop"] = desktopBefore.changes(to: DesktopState.now())
        if session?.id == id { session?.receipts[requestID] = receipt }
        return text(receipt)
    }
    private func next(_ current: Session) -> String {
        current.paused ? "human_takeover" : "observe"
    }
    private func phase(_ current: Session) -> String {
        if let deadline = current.interactionDeadline, now < deadline { return "person_interacting" }
        if current.paused { return "ready_to_continue" }
        return current.needsRefresh ? "refreshing" : "working"
    }
    private func desktopAvailability(_ available: Bool) {
        desktopAvailable = available
        guard session != nil else { return }
        session?.generation += 1; session?.observation = nil; session?.records = []; session?.focus = nil; session?.needsRefresh = true
        stopWatching(); input.releaseAll()
        // Sleep/idle availability is technical, not the person's Take over.
        // Preserve any real pause, and require fresh validated reads on return.
        if session?.paused != true { controls.update(available ? "Refreshing the selected window…" : "Waiting for the desktop…", paused: false) }
    }
    func pause(_ reason: String, announce: Bool = true) {
        guard let current = session, !current.paused || resumingSessionID == current.id else { return }
        session?.pauseReason = reason
        session?.interactionDeadline = nil
        session?.needsRefresh = true
        session?.paused = true; session?.generation += 1; session?.observation = nil; session?.records = []; session?.focus = nil
        // A takeover leaves the front wherever the person puts it.
        handBack.forget(); handBackTimer?.invalidate(); handBackTimer = nil
        stopWatching()
        input.releaseAll()
        if announce { controls.update(reason, paused: true) }
    }
    private static let interruptions: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]
    /// When the person last produced physical input of this type, in uptime. The
    /// HID system state holds only device input, never the agent's process-targeted
    /// events. Reads only timing, with no permission beyond computer use's own.
    private func lastPersonInput(_ type: CGEventType) -> TimeInterval {
        ProcessInfo.processInfo.systemUptime - CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: type)
    }
    private func personInterrupted(since start: TimeInterval) -> Bool {
        Self.interruptions.contains { SharedDesktop.personInterrupted(inputAt: lastPersonInput($0), since: start) }
    }
    /// A physical mouse button held down right now.
    private func personHoldsButton() -> Bool {
        [CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.hidSystemState, button: $0) }
    }
    /// In foreground control, takes the next gap in the person's typing or a held button.
    private func takeGap(_ current: Session, deadline: TimeInterval? = nil, front: Bool? = nil) async throws {
        guard front ?? current.takesFront else { return }
        try await SharedDesktop.takeGap(busy: {
            SharedDesktop.personBusy(keyAt: self.lastPersonInput(.keyDown), buttonDown: self.personHoldsButton(),
                now: ProcessInfo.processInfo.systemUptime)
        }, now: { self.now }, check: {
            try self.checkActive(current, deadline: deadline)
        }, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
    }
    /// Brings the selected window to the front, remembering which app had it. A click
    /// or key of the person's while it comes forward stops whatever was to follow.
    private func takeFront(_ current: Session) async throws {
        handBack.record(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            target: current.frontApp.pid, own: ProcessInfo.processInfo.processIdentifier, at: ProcessInfo.processInfo.systemUptime)
        do {
            try await SharedDesktop.acquire(now: { ProcessInfo.processInfo.systemUptime }, buttonDown: { self.personHoldsButton() },
                focus: { try await self.focusTarget(current) }, interrupted: { self.personInterrupted(since: $0) })
        } catch let error as UseError where error.code == SharedDesktop.interrupted.code {
            // Their input may have landed in the agent's window: the front stays there,
            // and the read that follows does not take it again.
            handBack.forget()
            session?.yielded = true
            throw error
        }
    }
    /// Before input: takes a gap in the person's typing, then brings the selected
    /// window back if something else came to the front. Returns whether it refocused.
    /// A click or key since the step began (`since`) leaves the front with the person.
    private func shareDesktop(_ current: Session, returns: inout Int, since step: TimeInterval, deadline: TimeInterval? = nil, front: Bool? = nil) async throws -> Bool {
        guard front ?? current.takesFront else { return false }
        session?.yielded = false
        try await takeGap(current, deadline: deadline, front: true)
        do {
            return try await SharedDesktop.returnFocus(used: &returns, inFront: { self.inFront(current) }, personActed: { self.personInterrupted(since: step) }, focus: { try await self.takeFront(current) })
        } catch let error as UseError where error.code == SharedDesktop.interrupted.code {
            // The read that follows leaves the front where the person has it.
            session?.yielded = true
            throw error
        }
    }
    /// Gives the front back once the agent's moment is over: no call within
    /// `handBackDelay`, so an action and the read after it count as one moment.
    private func scheduleHandBack() {
        handBackTimer?.invalidate(); handBackTimer = nil
        guard handBack.pid != nil else { return }
        let timer = Timer(timeInterval: SharedDesktop.handBackDelay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.giveBack() }
        }
        RunLoop.main.add(timer, forMode: .common)
        handBackTimer = timer
    }
    private func giveBack() {
        handBackTimer?.invalidate(); handBackTimer = nil
        guard !busy, let current = session, !current.paused else { return }
        // Another agent bringing its window forward keeps the front, and hands it back itself.
        guard let focus = FocusLease.attempt() else { handBack.forget(); return }
        defer { focus.release() }
        // Any click or key since the front was taken, even one that might be the
        // agent's own, means the person may be working in the agent's window.
        let latest = Self.interruptions.map { lastPersonInput($0) }.max() ?? -.infinity
        guard let pid = handBack.take(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                  target: current.frontApp.pid, lastPersonInput: latest),
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return }
        _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        app.activate(options: [])
    }
    private func confirmsFilePanel(_ current: Session, observation: ObservationLease, actions: [Action]) -> Bool {
        let button = access.defaultButton(current.target)
        return actions.contains { action in
            switch action {
            case .press(let ref):
                return DialogRules.confirmsFilePanel(action, pressed: current.records.first { $0.ref == ref }?.element, defaultButton: button)
            case .click(let point, _, _):
                // A click on the button's title lands on a child of the button.
                guard let screen = try? observation.screenPoint(point),
                      let hit = try? access.checkHit(screen, target: current.target, app: current.app, background: true) else { return button != nil }
                return DialogRules.confirmsFilePanel(action, pressed: hit, defaultButton: button)
                    || DialogRules.confirmsFilePanel(action, pressed: access.elementAttribute(hit, kAXParentAttribute), defaultButton: button)
            default:
                return DialogRules.confirmsFilePanel(action, pressed: nil, defaultButton: button)
            }
        }
    }
    /// The session's window is in front; for a dialog, its parent's app is.
    private func inFront(_ current: Session) -> Bool {
        guard current.parents.isEmpty else { return NSWorkspace.shared.frontmostApplication?.processIdentifier == current.frontApp.pid }
        return (try? access.validate(current.target, app: current.app, requireFrontmost: true)) != nil
    }
    /// Works in a dialog an action opened over the session's window, and returns to
    /// the window once it closes. Each switch needs a fresh observation. Returns
    /// whether the scope changed.
    @discardableResult
    private func followDialog(_ id: String) async throws -> Bool {
        guard let current = session, current.id == id, !current.paused else { return false }
        var changed = false
        // Closed dialogs, innermost first.
        while let parent = session?.parents.last, let scope = session, !access.dialogOpen(scope.target, app: scope.app) {
            session?.parents.removeLast()
            session?.app = parent.app; session?.target = parent.target
            session?.dialogKind = parent.kind
            // A closed panel's approval ends with it; a later panel asks again. Closing
            // the panel's own sheet returns to the same, still-approved panel.
            if session?.filePanelAllowed == scope.target.id { session?.filePanelAllowed = nil }
            session?.returnedFromDialog = true
            changed = true
        }
        // Something new over the current scope, at most three deep (a panel's own sheet): an
        // open menu, a dialog, or a window the last action opened and the app focused.
        let opened = session?.openedByLastAction ?? []
        session?.openedByLastAction = []
        if let scope = session, scope.parents.count < 3 {
            var next = await access.openMenu(of: scope.app)
            if next == nil { next = await access.dialog(over: scope.target, app: scope.app) }
            if next == nil, scope.dialogKind != .menu { next = await access.openedWindow(by: opened, over: scope.target, app: scope.app) }
            if let dialog = next, session?.id == id, !scope.parents.contains(where: { $0.target.id == dialog.target.id }) {
            session?.parents.append((scope.app, scope.target, scope.dialogKind))
            session?.app = dialog.app; session?.target = dialog.target; session?.dialogKind = dialog.kind
            session?.returnedFromDialog = false
            changed = true
            }
        }
        if changed {
            session?.generation += 1; session?.observation = nil; session?.records = []; session?.focus = nil; session?.needsRefresh = true
        }
        return changed
    }
    private func focusTarget(_ current: Session) async throws {
        guard desktopAvailable else { throw UseError("desktop_unavailable", "The desktop is temporarily unavailable. Observe again when available.", next: "observe") }
        // A dialog comes forward with its parent window and app.
        let window = current.frontTarget, owner = current.frontApp
        if current.mode == .control {
            _ = try access.validate(window, app: owner)
            guard AXUIElementPerformAction(window.element, kAXRaiseAction as CFString) == .success,
                  owner.app.activate(options: []) else {
                throw UseError("window_unavailable", "The selected window could not be focused. Refresh the app state.", next: "observe")
            }
            // Request focus once; never keep stealing it if a person intervenes.
            for attempt in 0..<10 {
                guard session?.id == current.id, session?.generation == current.generation else { throw UseError("session_changed", "Control changed during focus. No input was dispatched.", next: "observe") }
                if inFront(current) { break }
                if attempt < 9 { try await Task.sleep(nanoseconds: 50_000_000) }
            }
        }
        guard desktopAvailable else { throw UseError("desktop_unavailable", "The desktop is temporarily unavailable. Observe again when available.", next: "observe") }
        guard session?.id == current.id, session?.generation == current.generation else { throw UseError("session_changed", "Control changed during focus.", next: "observe") }
        if current.parents.isEmpty { _ = try access.validate(window, app: owner, requireFrontmost: current.mode == .control) }
        else {
            _ = try access.validate(current.target, app: current.app)
            guard current.mode != .control || inFront(current) else {
                throw UseError("window_not_frontmost", "The dialog's window could not be brought forward.", next: "observe")
            }
        }
    }
    private func resume() async {
        guard let current = session, current.paused, resumingSessionID == nil,
              current.interactionDeadline.map({ now >= $0 }) ?? true else { return }
        resumingSessionID = current.id
        defer { if resumingSessionID == current.id { resumingSessionID = nil } }
        do {
            // Only the person's explicit Continue can resume a human pause.
            let focus = current.takesFront ? try await FocusLease.acquire(check: {
                guard self.session?.id == current.id, self.session?.generation == current.generation else {
                    throw UseError("session_changed", "Control changed before Continue.", next: "observe")
                }
            }) : nil
            defer { focus?.release() }
            let keys = current.takesFront ? try await FocusLease.acquire(app: current.app.pid, check: {
                guard self.session?.id == current.id, self.session?.generation == current.generation else {
                    throw UseError("session_changed", "Control changed before Continue.", next: "observe")
                }
            }) : nil
            defer { keys?.release() }
            // A background session stays behind the person's work; each step readies its window.
            if current.delivery != .background { try await focusTarget(current) }
            guard session?.id == current.id, session?.generation == current.generation else { return }
            _ = try access.validate(current.target, app: current.app, requireFrontmost: current.takesFront)
            expire(); guard session != nil else { return }
            session?.pauseReason = nil
            session?.interactionDeadline = nil
            session?.needsRefresh = true
            session?.paused = false; session?.generation += 1; session?.observation = nil; session?.lastUsed = now
            controls.update("Refreshing the selected window before continuing…", paused: false)
        } catch {
            guard session?.id == current.id, session?.generation == current.generation else { return }
            session?.pauseReason = error.localizedDescription
            session?.interactionDeadline = nil
            controls.update(error.localizedDescription, paused: true)
        }
    }
    private func expire() {
        guard let current = session else { return }
        if let deadline = current.interactionDeadline, now >= deadline {
            session?.interactionDeadline = nil
            controls.update(current.pauseReason ?? "You have control. Click Continue when you are ready.", paused: true)
        }
        controls.updateExpiry(seconds: max(0, Int(900 - (now - current.started))))
        if current.app.app.isTerminated { close(); return }
        // Renew technical accounting silently. Preserve paused state, generation,
        // target validation, observation freshness and at-most-once receipts.
        if now - current.started >= 900 { session?.started = now }
    }
    func close(stoppedByPerson: Bool = false) {
        giveBack(); handBack.forget()
        stopWatching()
        resumingSessionID = nil; session = nil
        input.releaseAll(); lease = nil; controls.close(stoppedByPerson: stoppedByPerson)
    }
    func cancel() {
        // Cancellation is terminal, including an idle agent turn's pending call.
        close()
    }
    private func text(_ payload: [String: Any]) -> [[String: Any]] {
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return [["type": "text", "text": String(decoding: data, as: UTF8.self)]]
    }
}
