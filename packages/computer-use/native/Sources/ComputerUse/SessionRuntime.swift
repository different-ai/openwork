import AppKit
import ApplicationServices
import Carbon.HIToolbox

@MainActor
final class SessionRuntime {
    private let access = MacAccessibility()
    private let input = MacInput()
    private let controls = SessionControls()
    private let clipboard = AgentClipboard()
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
    /// Where the person was when this moment took the front.
    private var personPlace: SharedDesktop.Place<AXUIElement>?
    /// The person was writing in a field when this call waited for a gap.
    private var momentTyping = false
    /// How long this call waited for the person to pause.
    private var waitedForPerson: TimeInterval = 0
    /// What is left of this call's `SharedDesktop.busyLimit` for waiting on the person.
    private var personWaitLeft = SharedDesktop.busyLimit
    private let backgroundDelivery = ProcessInfo.processInfo.environment[InputDelivery.hostVariable] == InputDelivery.background.rawValue

    private struct Session {
        let id: String
        /// What observations and input work in: the session's window, or a dialog over it.
        var app: AppIdentity
        var target: WindowTarget
        let mode: AccessMode
        /// Background until the app shows it needs the front for keys or pointer steps.
        var delivery: InputDelivery
        /// The app takes real input: a known app that drops input addressed to its process,
        /// or one where a real-input step the agent asked for visibly worked (`RealInputUse`).
        var realInput = false
        /// How the last act's input went, read by the next observation (`RealInputUse`).
        var lastInput: RealInputUse.Sent?
        /// Whether the person follows along in OpenWork; nil when the host does not say.
        var follow: FollowAlong?
        /// The person watches this chat: the session works in front, beside OpenWork.
        var followed = false
        /// How control input reaches the window now.
        var working: InputDelivery { followed ? .foreground : delivery }
        /// The windows under the dialogs being worked in, the session's own first.
        var parents: [(app: AppIdentity, target: WindowTarget, kind: DialogTarget.Kind?)] = []
        /// Windows the last action opened: the only new windows a session follows.
        var openedByLastAction: Set<CGWindowID> = []
        /// The app's windows before the last act that sent input: what a window the app put in place
        /// of the closed session window is new against (`WindowReplacement`).
        var windowsBeforeInput: (windows: Set<CGWindowID>, at: TimeInterval)?
        var dialogKind: DialogTarget.Kind?
        /// A dialog closed since the last observation and the session is back in its window.
        var returnedFromDialog = false
        /// The file panel the person let the agent look through.
        var filePanelAllowed: CGWindowID?
        /// Control input that brings the window to the front first. Dialogs always take it.
        var takesFront: Bool { mode == .control && (working == .foreground || !parents.isEmpty) }
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
        var refs = StableRefs<AXUIElement>()
        var actionCount = 0
        var receipts: [String: [String: Any]] = [:]
        var receiptInputs: [String: Data] = [:]
        var focus: ElementRecord?
        var baseline: ActionBaseline?
        /// The last image the model received; an identical automatic one is not sent again.
        var lastImage: ImagePolicy.Sent?
        /// The person interrupted the last step; the read right after it leaves the front to them.
        var yielded = false
        /// Where the window was before the session first arranged it; put back on close.
        var placement: WindowArrangement.Placement?
        /// When the last act's last input was the agent's own click (or focus step) in this window, in
        /// uptime: canvas text typed in the next act may go where it put the keyboard.
        var lastClick: TimeInterval?
    }
    init(policy: RuntimePolicy = .desktop, clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.policy = policy; self.clock = clock
        controls.onPause = { [weak self] reason in self?.pause(reason) }
        controls.onAvailability = { [weak self] available in self?.desktopAvailability(available) }
        controls.onResume = { [weak self] in Task { await self?.resume() } }
        controls.onStop = { [weak self] in self?.close(stoppedByPerson: true) }
        controls.onTick = { [weak self] in self?.expire() }
        controls.onWatch = { [weak self] visible in self?.watchWindow(visible: visible) }
        controls.onFollow = { [weak self] watching, beside, stage in self?.session?.follow?.host(watching: watching, beside: beside, stage: stage) }
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
        momentTyping = false; waitedForPerson = 0; personWaitLeft = SharedDesktop.busyLimit; handBack.beginMoment()
        busy = true; defer { busy = false; scheduleHandBack() }
        switch name {
        case "computer_discover":
            try a.only([])
            return text(discover())
        case "computer_open_session":
            // Set only by the trusted host: whether the person watches this chat, whether the
            // window may go beside OpenWork (not while the chat has several apps open), the
            // chat's clipboard key, and the file approval for opening the app onto a file.
            try a.only(policy == .embedded ? ["app_id", "pid", "window_id", "mode", "purpose", "following", "beside", "stage_slot", "stage_count", "clipboard", "file", "file_approval"] : ["app_id", "pid", "window_id", "mode", "purpose"])
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
            var follow = values["following"] == nil ? nil : FollowAlong(watching: try a.bool("following", default: false), beside: try a.bool("beside", default: true),
                stage: values["stage_count"] == nil ? nil : try StageSlot.parse(a))
            // A person watching the chat sees the app come forward; otherwise it opens behind their work.
            let followed = mode == .control && follow?.follows(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier, host: Responsibility.hostPID,
                target: pid ?? NSRunningApplication.runningApplications(withBundleIdentifier: appID).first?.processIdentifier) == true
            let background = delivery == .background && !followed
            // Set only by the trusted host: its key for this chat's own clipboard.
            if policy == .embedded, values["clipboard"] != nil { try clipboard.use(chat: try a.string("clipboard", max: 64)) }
            // Opening the app onto a file hands the file to it: the host confirms this exact file first.
            let file = policy == .embedded && values["file"] != nil ? try FileHandoff.file(try a.string("file", max: 1024)) : nil
            let approved = file.map { values["file_approval"] as? [String] == [$0.path] } ?? false
            var typeNote: String?
            if let file, AppIdentity.isAllowed(bundleID: appID) {
                let name = NSRunningApplication.runningApplications(withBundleIdentifier: appID).first?.localizedName
                    ?? installed.map { FileManager.default.displayName(atPath: $0.path) } ?? appID
                switch FileTypeCheck.of(file, app: name, info: installed.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:]) {
                case .unsupported(let message): throw UseError("file_type_unsupported", message, next: "correct_request")
                case .note(let note): typeNote = note
                case .fits: break
                }
            }
            if let file, !approved, AppIdentity.isAllowed(bundleID: appID) {
                let name = NSRunningApplication.runningApplications(withBundleIdentifier: appID).first?.localizedName
                    ?? installed.map { FileManager.default.displayName(atPath: $0.path) } ?? appID
                return text(["ok": false, "code": "files_approval_required", "files": [file.path], "app": name, "dispatched": false,
                    "next": "open_session", "message": "Opening the app onto a file hands the file to it. OpenWork checks the organization's rule first; nothing was opened."])
            }
            // An app that is not running starts on the document, instead of an empty window or an Open panel.
            var launchedOnFile: pid_t?
            if let file, approved, pid == nil, !NSRunningApplication.runningApplications(withBundleIdentifier: appID).contains(where: AppIdentity.isLive),
               AppIdentity.isAllowed(bundleID: appID), let installed, Bundle(url: installed)?.bundleIdentifier == appID {
                launchedOnFile = try await FileHandoff.open(file, in: installed, activates: !background).processIdentifier
                var tries = 0
                while tries < 30, (try? AppIdentity.resolve(appID, pid: launchedOnFile)) == nil {
                    tries += 1; try Task.checkCancellation(); try await Task.sleep(nanoseconds: 100_000_000)
                }
            }
            let identity = try await AppIdentity.open(appID, pid: pid ?? launchedOnFile, activates: !background)
            let windowsBefore = access.windowChanges(identity)
            if let file, approved, launchedOnFile == nil {
                guard let bundle = identity.app.bundleURL else { throw UseError("app_unavailable", "The app's location is unknown. Nothing was opened.", next: "discover") }
                _ = try await FileHandoff.open(file, in: bundle, activates: !background)
            }
            var windows = try await access.windows(identity)
            // A success from Launch Services is not proof: the document counts as open once its window shows.
            var fileWindow: Int?
            var fileAlert: [String: Any]?
            if let file, approved {
                for _ in 0..<30 {
                    try Task.checkCancellation()
                    let opened = access.windowChanges(identity).windows.subtracting(windowsBefore.windows)
                    fileWindow = FileHandoff.window(for: file, in: windows.map { (Int($0.id), $0.title) }, opened: Set(opened.map(Int.init)))
                    if fileWindow != nil { break }
                    // The app refused the file with an alert, such as "could not be opened".
                    if let alert = access.frontAlert(identity) { fileAlert = alert; break }
                    try await Task.sleep(nanoseconds: 100_000_000)
                    windows = try await access.windows(identity)
                }
            }
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
            let focusedID = fileWindow ?? access.focusedWindowID(identity, windows: windows, requireActive: !background)
            let targetID = try WindowSelection.resolve(ids: windows.map { Int($0.id) }, requested: requested, focused: focusedID,
                descriptions: windows.map { "\($0.id): \($0.title)" })
            guard let target = windows.first(where: { Int($0.id) == targetID }) else { throw UseError("window_unavailable", "The resolved window closed.", next: "open_session") }
            try Task.checkCancellation()
            _ = try access.validate(target, app: identity)
            let reservation = try ControlLease(pid: identity.pid, window: target.id)
            let id = UUID().uuidString.lowercased()
            session = Session(id: id, app: identity, target: target, mode: mode, delivery: delivery, follow: follow, followed: followed, started: now, lastUsed: now, purpose: purpose)
            session?.realInput = mode == .control && InputDelivery.needsRealInput(bundleID: appID,
                info: installed.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:], frameworks: frameworks)
            lease = reservation
            controls.show(app: identity, target: target, mode: mode, purpose: purpose, background: background)
            if mode == .control, !background, let current = session {
                // Initial focus is technical startup, never a human pause/Continue flow.
                let focus = try await FocusLease.acquire(check: { try self.checkActive(current) })
                defer { focus.release() }
                let keys = try await FocusLease.acquire(app: current.app.pid, check: { try self.checkActive(current) })
                defer { keys.release() }
                do { try await aroundPerson(current) { try await self.takeGap(current); try await self.takeFront(current) } }
                catch let error as UseError where error.code == SharedDesktop.busy.code {
                    // Nothing stays half open: the host opens the session again later.
                    close()
                    throw error
                } catch let error as UseError where error.code == WindowFront.refused.code {
                    // The session opens with its window where it is: each step takes the front again.
                }
                if followed { arrangeBeside(id) }
            }
            guard let opened = session, opened.id == id else { throw UseError("session_unavailable", "Access ended while starting. Stop work and wait for a new user request.", next: "human_takeover") }
            var result: [String: Any] = ["ok": true, "session_id": id, "app_id": identity.bundleID, "app_name": identity.name, "pid": Int(identity.pid),
                "window_id": Int(target.id), "window_title": target.title, "mode": mode.rawValue, "delivery": delivery.rawValue, "followed": followed,
                "state": opened.paused ? "paused" : "active", "expires_in_seconds": 900,
                "next": next(opened)]
            if file != nil {
                result["file"] = FileOpenCheck.outcome(alert: fileAlert, documentWindowOpened: fileWindow != nil, retitled: false)
                if let typeNote { result["type_note"] = typeNote }
                if let fileAlert { result["file_alert"] = fileAlert }
            }
            return text(result)
        case "computer_observe":
            let options = try ObservationOptions(values, policy: policy)
            return try await observe(try a.string("session_id"), image: options.image, elements: options.elements, menus: options.menus,
                filePanelAccess: policy == .embedded ? (values["file_panel_access"] as? NSNumber)?.uint32Value : nil)
        case "computer_act":
            try a.only(policy == .embedded ? ["session_id", "observation_id", "request_id", "action", "actions", "intent", "file_approval", "file_panel_access", "pacing", "retry_ms", "credential_approval", "input"] : ["session_id", "observation_id", "request_id", "action"])
            let id = try a.string("session_id")
            let observationID = try a.string("observation_id")
            let requestID = try a.string("request_id", max: 100)
            let actions = try Action.batch(values, policy: policy)
            let pacing = policy == .embedded ? try BatchPacing(values) : .fast
            let requestedReal = policy == .embedded ? try RealInputUse.requested(values["input"]) : false
            // Pacing and input change how the batch runs, so a reused request_id must name them too.
            let raw: Any = ["steps": values["actions"] ?? values["action"] ?? NSNull(), "pacing": pacing.mode.rawValue, "retry_ms": Int(pacing.retry * 1_000),
                "input": requestedReal ? "real" : "auto"]
            // Display only: shown on the person's desktop cursor, never part of the receipt identity.
            let intent = values["intent"] == nil ? nil : try a.string("intent", max: 120)
            // Set only by the trusted host: the exact names the person approved handing over,
            // and whether they let the agent look through a file panel at all.
            let fileApproval = policy == .embedded ? values["file_approval"] as? [String] : nil
            // The panel the person allowed, by its window: never whichever panel is open now.
            let panelAccess = policy == .embedded ? (values["file_panel_access"] as? NSNumber)?.uint32Value : nil
            // The app the person confirmed may receive a password or code they gave.
            let credentialApproval = policy == .embedded ? values["credential_approval"] as? String : nil
            do {
                return try await act(id: id, observationID: observationID, requestID: requestID, actions: actions, raw: raw, intent: intent,
                    fileApproval: fileApproval, filePanelAccess: panelAccess, pacing: pacing, credentialApproval: credentialApproval, requestedReal: requestedReal)
            } catch let error as UseError {
                // Refused before anything was sent: the cursor shakes it off and tries another way.
                if error.next == "observe" || error.next == "correct_request" { controls.react(.refused) }
                throw error
            }
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
        // An app macOS quit while it had no windows is listed as installed, with no pid to pin.
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && AppIdentity.isAllowed($0) && AppIdentity.isLive($0) }
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
            "keys": policy.keys, "guidance": policy.instructions]
        if policy == .embedded {
            limits["batch_actions"] = Action.batchLimit
            result["modifiers"] = NativeKey.supportedModifiers
            result["shortcuts"] = NativeKey.shortcuts.union(NativeKey.clipboard).sorted()
            result["blocked_shortcuts"] = NativeKey.blockedShortcuts.filter { !NativeKey.clipboard.contains($0) }
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
    /// A macOS prompt only the person may answer is open. Before an observation has
    /// waited for them, the next step is that observation.
    private func personNeeded(_ prompt: (reason: String, app: String), waited: Bool = false) -> [[String: Any]] {
        text(["ok": false, "code": "person_needed", "reason": prompt.reason, "prompt_app": prompt.app, "dispatched": false,
              "next": waited ? "human_takeover" : "observe", "message": HandoverRules.message(prompt.reason, waited: waited)])
    }
    /// A file panel lists the person's files: nothing of it reaches the agent until they allow it.
    /// The session's window closed after the agent's own input and the app showed exactly one new
    /// window: the session works there from now on, as `computer_open` onto a file opens in the
    /// window the file shows in. Its controls and refs are new, so the next act needs an observation.
    /// Only for the session's own window, never a dialog's, and only into a window no other agent holds.
    /// `settle` waits that long for the app to close the window and show its replacement.
    private func followReplacement(_ id: String, settle: TimeInterval = 0) async -> [String: Any]? {
        guard let current = session, current.id == id, current.parents.isEmpty, !current.paused,
              let before = current.windowsBeforeInput, now - before.at < WindowReplacement.within else { return nil }
        let until = now + settle
        var found: (id: UInt32, windows: [WindowTarget])?
        while found == nil {
            let changes = access.windowChanges(current.app)
            let after = changes.windows.union(changes.panels)
            if !after.contains(current.target.id), after.subtracting(before.windows).count > 0 {
                let windows = (try? await access.windows(current.app)) ?? []
                let focused = access.focusedWindowID(current.app, windows: windows, requireActive: false).map(UInt32.init)
                if let replacement = WindowReplacement.replacement(before: before.windows, after: after, target: current.target.id, focused: focused) {
                    found = (replacement, windows)
                    break
                }
            }
            guard now < until, (try? await Task.sleep(nanoseconds: 100_000_000)) != nil, session?.id == id else { break }
        }
        guard let found, let target = found.windows.first(where: { $0.id == found.id }),
              (try? access.validate(target, app: current.app)) != nil,
              let reservation = try? ControlLease(pid: current.app.pid, window: target.id),
              session?.id == id else { return nil }
        lease = reservation
        session?.target = target; session?.windowsBeforeInput = nil; session?.dialogKind = nil
        session?.generation += 1; session?.observation = nil; session?.records = []; session?.focus = nil; session?.needsRefresh = true
        controls.update("Working in the app's new window…", paused: false)
        return ["window_id": Int(target.id), "window_title": target.title]
    }
    private enum PanelWait { case unchanged, observed(String), approval([[String: Any]]) }
    /// An Open or Place panel the app is still opening when open_in_panel arrives (a menu command's
    /// panel can take seconds): wait for it (`OpenPanelRules.wait`), follow it, sheet or window of its
    /// own, and look at it here. The step uses only the panel, never an observed element or point, so
    /// the model need not see it first. A panel the person has not let the agent see asks them first.
    private func awaitOpenPanel(_ id: String, filePanelAccess: CGWindowID?) async throws -> PanelWait {
        let until = now + OpenPanelRules.wait
        var followed = false
        while true {
            if try await followDialog(id) { followed = true }
            let current = try current(id)
            if OpenPanelRules.isOpenPanel(kind: current.dialogKind, saveField: access.saveNameField(current.target) != nil,
                defaultButton: access.defaultButton(current.target).flatMap { access.attribute($0, kAXTitleAttribute) as? String }) {
                guard followed || current.observation == nil else { return .unchanged }
                if current.filePanelAllowed != current.target.id, filePanelAccess != current.target.id { return .approval(filePanelAccessRequired(current)) }
                _ = try await observe(id, image: false, elements: "interactive", filePanelAccess: filePanelAccess)
                return session?.observation.map { .observed($0.id) } ?? .unchanged
            }
            guard now < until else { return .unchanged }
            try await Task.sleep(nanoseconds: 100_000_000); try checkActive(current)
        }
    }
    private func filePanelAccessRequired(_ current: Session) -> [[String: Any]] {
        text(["ok": false, "code": "file_panel_approval_required", "app": current.frontApp.name, "panel_id": Int(current.target.id), "dispatched": false, "next": "observe",
              "message": "A file panel opened. The person is asked before the agent sees their files; nothing was read."])
    }
    /// The app replaced the session's window while it was being read: the read starts over on the new one.
    private struct ReplacementFollowed: Error { let replaced: [String: Any] }
    private func observe(_ id: String, image: Bool?, elements: String, menus: Bool = false, filePanelAccess: CGWindowID? = nil) async throws -> [[String: Any]] {
        do { return try await observeOnce(id, image: image, elements: elements, menus: menus, filePanelAccess: filePanelAccess) }
        catch let followed as ReplacementFollowed {
            return try await observeOnce(id, image: image, elements: elements, menus: menus, filePanelAccess: filePanelAccess, replaced: followed.replaced)
        }
    }
    private func observeOnce(_ id: String, image: Bool?, elements: String, menus: Bool, filePanelAccess: CGWindowID?,
                             replaced known: [String: Any]? = nil) async throws -> [[String: Any]] {
        // A paused session never resumes from an observation: only the person's Continue does.
        // Retry only read-only capture races. Never repeat an action or cross takeover.
        // The app put a new window in place of the one the last action closed, after its receipt.
        var replaced = known
        if replaced == nil { replaced = await followReplacement(id) }
        try await followDialog(id)
        if access.personPrompt() != nil {
            // Only the person can answer it: wait here, so the agent carries on once they
            // do instead of handing its turn back. Answering may have closed a dialog.
            let waiting = try current(id)
            controls.update("Waiting for you to answer macOS. The agent continues once you do.", paused: false)
            if let open = try await HandoverRules.waitForPerson(prompt: { self.access.personPrompt() }, check: { try self.checkActive(waiting) },
                now: { self.now }, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
                return personNeeded(open, waited: true)
            }
            try await followDialog(id)
        }
        // A look is where the window goes beside OpenWork: the next action then sees it there.
        if refreshFollow(id) { arrangeBeside(id) }
        let current = try current(id)
        if current.dialogKind == .filePanel, current.filePanelAllowed != current.target.id {
            guard filePanelAccess == current.target.id else { return filePanelAccessRequired(current) }
            // Allowed for this panel until it closes; another panel asks again.
            session?.filePanelAllowed = current.target.id
        }
        session?.needsRefresh = true
        controls.update("Refreshing the selected window before continuing…", paused: false)
        if current.parents.isEmpty { try await access.bringHere(current.target, app: current.app) }
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
        var otherWindowFocused = current.mode == .control && current.working == .background && current.parents.isEmpty
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
            do { _ = try await SharedDesktop.returnFocus(used: &returns, inFront: { false }, focus: { try await self.takeFront(current) }) }
            catch let error where SharedDesktop.isPersonInput(error) {
                // The person clicked or typed first: look without the front, which stays with them.
                self.handFrontBack(current)
                otherWindowFocused = true
            } catch let error as UseError where error.code == WindowFront.refused.code {
                // A look does not need the front: read the window where it is; the next step tries again.
                otherWindowFocused = true
            }
        }
        return try await ObservationPreparation.capture(mode: current.mode, check: {
            try self.checkActive(current)
        }, focus: bringBack, read: {
            for attempt in 0..<3 {
                try self.checkActive(current)
                do { return try await self.observeAttempt(id, image: image, elements: elements, menus: menus, otherWindowFocused: otherWindowFocused, replaced: replaced) }
                catch let error as UseError {
                    if error.code == "window_not_frontmost", current.checksFront, attempt < 2 {
                        try await bringBack()
                        continue
                    }
                    // The window is going away under the read, as one a step just replaced does: once
                    // the app shows the new one, the read is of that window.
                    if ["accessibility_unavailable", "window_unavailable"].contains(error.code), attempt < 2,
                       let followed = await self.followReplacement(id, settle: WindowReplacement.settle) {
                        throw ReplacementFollowed(replaced: followed)
                    }
                    guard error.code == "stale_observation", attempt < 2 else { throw SharedDesktop.yielding(error) }
                    try await Task.sleep(nanoseconds: 75_000_000)
                }
            }
            throw UseError("stale_observation", "The window is still changing. Observe again.", next: "observe")
        })
    }
    private func observeAttempt(_ id: String, image requested: Bool?, elements filter: String, menus: Bool = false, otherWindowFocused: Bool = false,
                                replaced: [String: Any]? = nil) async throws -> [[String: Any]] {
        let current = try current(id)
        session?.observation = nil; session?.records = []; session?.focus = nil
        let frontmost = current.checksFront && !otherWindowFocused
        let bounds = try access.validate(current.target, app: current.app, requireFrontmost: frontmost)
        @MainActor func check() throws { try self.checkActive(current) }
        @MainActor func readState() async throws -> WindowState {
            let state = try await access.read(current.target, check: check)
            guard session?.id == id, var refs = session?.refs else { return state }
            let stable = refs.assign(state, window: current.target.id)
            session?.refs = refs
            return stable
        }
        var state = try await readState()
        var png: Data?
        var imageFailure: UseError?
        var width = max(1, Int(bounds.width)); var height = max(1, Int(bounds.height))
        let interactive = state.records.filter { bounds.contains($0.frame) && $0.interactive }
        let namedControls = interactive.filter { !$0.label.isEmpty }.count
        let image = ImagePolicy.include(requested: requested,
            automatic: ImagePolicy.automatic(delivery: current.working, mode: current.mode, policy: policy),
            namedControls: namedControls, interactiveControls: interactive.count)
        if image {
            // A window that just opened is often still settling: one more look
            // before the observation goes out without its image.
            for attempt in 0..<2 {
                do {
                    let captured = try await observationImage(current, bounds: bounds, state: state, requireFrontmost: frontmost, check: check)
                    png = captured.0; width = captured.1; height = captured.2; imageFailure = nil
                    break
                } catch {
                    try check()
                    let failure = (error as? UseError) ?? UseError("capture_failed", "The window screenshot is unavailable; only the accessible text was read.", next: "observe")
                    if failure.code == "stale_observation", policy == .desktop { throw failure }
                    imageFailure = failure
                    guard failure.code == "stale_observation" else { break }
                    if attempt == 0 { try await Task.sleep(nanoseconds: 120_000_000); try check() }
                    state = try await readState()
                }
            }
        }
        // Right after the agent's input, an animating window is observed once it holds still.
        var stillChanging = false
        if let first = png, policy == .embedded,
           ObservationSettle.applies(info: current.app.app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:], baseline: current.baseline) {
            let (settled, still) = try await ObservationSettle.settle(first: (state, first, width, height), digest: { self.access.imageDigest($0.1) + ((try? self.access.captureDigest($0.0)) ?? Data()) },
                capture: { () async throws -> (WindowState, Data, Int, Int)? in
                    do {
                        let next = try await readState()
                        let captured = try await self.observationImage(current, bounds: bounds, state: next, requireFrontmost: frontmost, check: check)
                        return (next, captured.0, captured.1, captured.2)
                    } catch let error as UseError where error.code == "stale_observation" {
                        // Still changing mid-capture: keep the last complete look.
                        return nil
                    }
                }, now: { self.now }, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)); try check() })
            state = settled.0; png = settled.1; width = settled.2; height = settled.3
            stillChanging = !still
        }
        if !image, policy == .desktop {
            let after = try await access.read(current.target, check: check)
            guard try access.captureDigest(state) == access.captureDigest(after) else {
                throw UseError("stale_observation", "The window changed during the read. Observe again.", next: "observe")
            }
        }
        try check()
        guard try access.validate(current.target, app: current.app, requireFrontmost: frontmost) == bounds else {
            throw UseError("stale_observation", "The window moved during the observation.", next: "observe")
        }
        let imageDigest = png.map(access.imageDigest)
        // The lease keeps the digest either way, so coordinate input still checks the live window against it.
        let repeated = imageDigest.flatMap { digest in
            ImagePolicy.alreadySent(requested: requested, last: current.lastImage, generation: current.generation,
                window: current.target.id, width: width, height: height, digest: digest)
        }
        var effectiveFilter = filter
        // AX trees can retain virtualized or scrolled-out nodes. Keep those
        // internal for privacy/staleness scans, never expose their text or refs.
        let visible = state.records.filter { bounds.contains($0.frame) }
        var shown = ElementFilter.shown(visible, filter: filter, dialog: current.dialogKind)
        if png == nil || repeated != nil, shown.isEmpty, filter == "interactive" { shown = visible; effectiveFilter = "all" }
        guard png != nil || !shown.isEmpty else {
            throw imageFailure ?? UseError("observation_unavailable", "No image or useful accessible elements could be read.", next: "observe")
        }
        let elements = try shown.map { try $0.payload(bounds: bounds, width: width, height: height, compact: policy == .embedded) }
        let observation = ObservationLease(id: UUID().uuidString.lowercased(), createdAt: now, generation: current.generation,
            frame: bounds, imageWidth: width, imageHeight: height, stateDigest: try access.captureDigest(state),
            contentDigest: try access.captureDigest(state, focus: false),
            imageDigest: imageDigest, validFor: policy.observationSeconds, image: png)
        try check()
        let observedFocus = state.focusRecord.flatMap { focus in shown.first { CFEqual($0.element, focus.element) } }
        let afterAction = current.baseline.flatMap { baseline in
            baseline.generation == current.generation ? baseline.changes(stateDigest: observation.stateDigest, imageDigest: observation.imageDigest) : nil
        }
        // Whether the app took the last input: real input that visibly worked stays on for this
        // session; input that changed nothing gets the hint to try it once as real input.
        let inputUse = RealInputUse.after(current.lastInput, changes: afterAction, alreadyReal: current.realInput)
        session?.observation = observation; session?.records = shown; session?.focus = observedFocus
        session?.lastUsed = now; session?.needsRefresh = false; session?.baseline = nil; session?.lastInput = nil
        if inputUse.keepReal { session?.realInput = true }
        if repeated == nil, let digest = observation.imageDigest {
            session?.lastImage = ImagePolicy.Sent(observationID: observation.id, generation: current.generation,
                window: current.target.id, width: width, height: height, digest: digest)
        }
        controls.update("Window observed. Ready for the next action.", paused: false)
        let sent = repeated == nil ? png : nil
        var imageInfo: [String: Any] = ["width": width, "height": height, "included": sent != nil, "coordinate_space": "image_pixels"]
        if let imageFailure { imageInfo["unavailable"] = imageFailure.payload }
        // The window was still animating when the look was taken: coordinates may need another look.
        if stillChanging { imageInfo["still_changing"] = true }
        if !image { imageInfo["omitted"] = requested == false ? "requested" : "accessible_controls_suffice" }
        if let repeated {
            imageInfo["omitted"] = "unchanged"
            imageInfo["same_as_observation"] = repeated.observationID
        }
        var payload: [String: Any] = ["ok": true, "session_id": id, "observation_id": observation.id, "window_id": Int(current.target.id),
            "window_title": current.target.title, "mode": current.mode.rawValue, "image": imageInfo, "elements": elements,
            "truncated": state.truncated || state.listCapped, "protected_fields": state.protectedFrames.count,
            "content_trust": "untrusted_app_content", "next": "act_once_then_observe"]
        if var afterAction {
            if inputUse.suggest { afterAction["real_input"] = RealInputUse.suggestion }
            if inputUse.keepReal { afterAction["real_input"] = "on" }
            payload["after_action"] = afterAction
        }
        if let reaction = CursorReaction.after(afterAction) { controls.react(reaction) }
        if otherWindowFocused { payload["other_window_focused"] = true }
        if let replaced { payload["window_replaced"] = replaced }
        if let kind = current.dialogKind {
            // Elements and coordinates are the dialog's; it is worked in until it closes.
            payload["dialog"] = ["kind": kind.rawValue, "title": current.target.title, "depth": current.parents.count]
        }
        if current.returnedFromDialog { payload["dialog_closed"] = true; session?.returnedFromDialog = false }
        if policy == .embedded {
            payload["elements_filter"] = effectiveFilter; payload["elements_total"] = visible.count
            payload["observation_seconds"] = Int(policy.observationSeconds)
            // A control keeps its ref across observations of this window; the host may list only changes.
            payload["refs"] = "stable"
            if let focus = observedFocus { payload["focused_ref"] = focus.ref }
            if let issue = state.privacyIssue { payload["privacy_issue"] = issue }
            if menus {
                // Read without opening a menu, so the agent can run a command in one step. An app in
                // the background lists its document commands once its window is its key window.
                if current.parents.isEmpty, !current.app.app.isActive { await MenuFocus.prime(app: current.app, window: current.target.id) }
                let catalog = access.menuCatalog(current.app)
                payload["menus"] = catalog.entries.map(\.display)
                if catalog.truncated { payload["menus_truncated"] = true }
                payload["menus_note"] = "Enabled menu-bar commands. Run one with {\"type\":\"menu\",\"path\":[titles]}: no menu needs opening and no keyboard focus is needed."
            }
        }
        var result: [[String: Any]] = []
        if let sent { result.append(["type": "image", "data": sent.base64EncodedString(), "mimeType": Self.observationMimeType]) }
        return result + text(payload)
    }

    /// Observations are compact JPEGs: image tokens and upload time dominate each step.
    /// The re-capture that guards coordinate input uses the same encoding, so digests compare;
    /// a session's mode never changes, so neither does its profile.
    static let observationMimeType = "image/jpeg"
    private func observationImage(_ current: Session, bounds: CGRect, state: WindowState, requireFrontmost: Bool,
                                  check: () throws -> Void) async throws -> (Data, Int, Int, Int64) {
        let profile = ImagePolicy.profile(mode: current.mode, policy: policy)
        return try await access.capture(target: current.target, app: current.app, bounds: bounds, state: state,
            maxLongSide: profile.maxLongSide, jpegQuality: profile.jpegQuality, requireFrontmost: requireFrontmost, check: check)
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
        let captured: (Data, Int, Int, Int64)
        do {
            captured = try await access.capture(target: current.target, app: current.app, bounds: bounds, state: state,
                region: region, maxScale: NSScreen.screens.map(\.backingScaleFactor).max() ?? 2, check: check)
        } catch let error as UseError {
            throw error
        } catch {
            // A screen capture error is not a takeover: the zoom only reads, and the observation is untouched.
            try check()
            throw UseError("capture_failed", "The zoomed image could not be captured. The observation is still valid; act on it or observe again.", next: "observe")
        }
        let (png, width, height, capturedAt) = captured
        try check()
        session?.lastUsed = now
        let payload: [String: Any] = ["ok": true, "session_id": id, "observation_id": observationID, "state": "active",
            "region": ["x": pixels.minX, "y": pixels.minY, "width": pixels.width, "height": pixels.height, "coordinate_space": "image_pixels"],
            "image": ["width": width, "height": height, "captured_at": capturedAt], "protected_fields": state.protectedFrames.count,
            "content_trust": "untrusted_app_content",
            "next": "Read only. Act with the same observation_id and coordinates from the original observation image, not this zoom."]
        return [["type": "image", "data": png.base64EncodedString(), "mimeType": "image/png"]] + text(payload)
    }

    /// The window as the agent sees it, at full resolution and with the same masks, written as a
    /// PNG. Reported only once the file reads back from disk; an incomplete privacy scan saves nothing.
    private func saveImage(_ current: Session, observationID: String, requestID: String, fingerprint: Data,
                           file: URL, region pixels: CGRect?, replace: Bool, fileApproval: [String]?) async throws -> [[String: Any]] {
        guard let observation = current.observation else { throw UseError("observation_required", "Observe this window before saving what it shows.", next: "observe") }
        let bounds = try access.validate(current.target, app: current.app)
        try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
        let region = try pixels.map { try WindowImage.windowRegion($0,
            image: CGSize(width: observation.imageWidth, height: observation.imageHeight), window: bounds.size) }
        try FileHandoff.refuseReplacing(file, replace: replace)
        // The organization's file rule decides, as for save_as: by default the agent goes ahead.
        guard let fileApproval, fileApproval == [file.path] else {
            return text(["ok": false, "code": "files_approval_required", "files": [file.path], "save": true,
                "app": current.app.name, "dispatched": false, "next": "observe",
                "message": "Saving writes this image once the organization's file rule allows it; nothing was saved."])
        }
        @MainActor func check() throws { try self.checkActive(current) }
        let state = try await access.read(current.target, check: check)
        try state.requireCapture()
        let captured: (Data, Int, Int, Int64)
        do {
            captured = try await access.capture(target: current.target, app: current.app, bounds: bounds, state: state,
                region: region, maxScale: WindowImage.scale(for: bounds), maxLongSide: WindowImage.maxLongSide, check: check)
        } catch let error as UseError {
            throw error
        } catch {
            try check()
            throw UseError("capture_failed", "The window could not be captured. Nothing was saved; the observation is still valid.", next: "observe")
        }
        let (png, width, height, _) = captured
        try check()
        let saved = try WindowImage.write(png, to: file, replace: replace)
        guard saved.width == width, saved.height == height else {
            throw UseError("save_unconfirmed", "The file on disk does not match the captured image. Check it before using it.", next: "observe")
        }
        session?.lastUsed = now
        let receipt: [String: Any] = ["ok": true, "status": "dispatched", "action": "save_image", "path": "file_saved",
            "steps": [["index": 0, "action": "save_image", "status": "dispatched", "path": "file_saved"]], "completed": 1,
            "saved_file": ["path": file.path, "bytes": saved.bytes, "width": saved.width, "height": saved.height],
            "protected_fields": state.protectedFrames.count, "request_id": requestID, "outcome_verified": true,
            "next": "The observation is still valid. To use the image in another app, open the file there."]
        if session?.id == current.id { session?.receipts[requestID] = receipt; session?.receiptInputs[requestID] = fingerprint }
        return text(receipt)
    }

    private func act(id: String, observationID: String, requestID: String, actions: [Action], raw: Any, intent: String? = nil,
                     fileApproval: [String]? = nil, filePanelAccess: CGWindowID? = nil, pacing: BatchPacing = .fast, credentialApproval: String? = nil,
                     requestedReal: Bool = false) async throws -> [[String: Any]] {
        let cached = try current(id, allowPaused: true)
        let fingerprint = try JSONSerialization.data(withJSONObject: ["observation_id": observationID, "action": raw], options: [.sortedKeys])
        if let receipt = cached.receipts[requestID] {
            guard cached.receiptInputs[requestID] == fingerprint else { throw UseError("request_id_reused", "A request_id cannot name a different action.") }
            return text(receipt)
        }
        // open_in_panel sent right after the command that opens the panel: wait for the panel and look at it here.
        var observationID = observationID
        if actions.count == 1, case .openInPanel = actions[0] {
            switch try await awaitOpenPanel(id, filePanelAccess: filePanelAccess) {
            case .observed(let looked): observationID = looked
            case .approval(let prompt): return prompt
            case .unchanged: break
            }
        }
        // A dialog opened or closed since the last look: its controls are not the observed ones.
        if try await followDialog(id) {
            throw UseError("observation_required", "A dialog opened or closed since the last observation. Observe again; nothing was sent.", next: "observe")
        }
        if let prompt = access.personPrompt() { return personNeeded(prompt) }
        refreshFollow(id)
        let current = try current(id)
        // A hidden or minimized window comes back without activating its app; one on another Space is reported.
        if current.parents.isEmpty { try await access.bringHere(current.target, app: current.app) }
        // Saving an image sends no input: any mode, no front, and the observation stays valid.
        if actions.contains(where: { if case .saveImage = $0 { return true }; return false }) {
            guard actions.count == 1, case .saveImage(let file, let region, let replace) = actions[0] else {
                throw UseError("save_image_alone", "Save an image as its own step. Nothing was sent.", next: "observe")
            }
            return try await saveImage(current, observationID: observationID, requestID: requestID, fingerprint: fingerprint,
                file: file, region: region, replace: replace, fileApproval: fileApproval)
        }
        if current.dialogKind == .filePanel, current.filePanelAllowed != current.target.id {
            guard filePanelAccess == current.target.id else { return filePanelAccessRequired(current) }
            // Allowed for this panel until it closes; another panel asks again.
            session?.filePanelAllowed = current.target.id
        }
        guard current.mode != .observe, !actions.contains(where: \.requiresControl) || current.mode == .control else {
            throw current.mode.refusal(actions)
        }
        if current.actionCount + actions.count > 200 { session?.actionCount = 0 }
        if current.receipts.count >= 200, let oldest = current.receipts.keys.first {
            session?.receipts.removeValue(forKey: oldest); session?.receiptInputs.removeValue(forKey: oldest)
        }
        guard let observation = current.observation else { throw UseError("observation_required", "Observe this window before acting. Each observation authorizes one act call.", next: "observe") }
        let desktopBefore = DesktopState.now()
        // In the background the person keeps the front, unless a step in this batch
        // only works while the app is active or follows the real pointer. That step waits
        // until the person is idle (`takeGap`, `aroundPerson`), takes the front for the step,
        // and gives back their app, window, field and caret (`scheduleHandBack`, `PersonPlace`).
        let route = input.route(for: current.app)
        let inBackground = current.mode == .control && current.working == .background && current.parents.isEmpty
        // Real input the agent asks for works only with the window in front, like a person's.
        let asksReal = requestedReal && current.mode == .control && current.parents.isEmpty
        // A sandboxed app's Save or Open panel is drawn by a macOS process of its own, which takes
        // keys (Go To's Command-Shift-G, Return) only as a person's: real input with the window in front.
        let panelKeys = current.mode == .control && current.dialogKind == .filePanel && actions.contains(where: \.usesFilePanel)
        let front = asksReal || panelKeys || current.takesFront || inBackground && actions.contains { InputDelivery.stepNeedsFront($0, route: route) }
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
        // theirs from here on pauses the step until they are idle, then it carries on.
        var moment = ProcessInfo.processInfo.systemUptime
        var returns = 0
        var disturbed = try await aroundPerson(current) {
            try await self.takeGap(current, front: front)
            moment = ProcessInfo.processInfo.systemUptime; returns = 0
            return try await self.shareDesktop(current, returns: &returns, since: moment, front: front)
        }
        // macOS reports the new front app a moment after the window comes forward; real input
        // checks the front app before each event, so the first one waits for that report.
        if front {
            await FrontReport.wait(for: current.frontApp.pid, frontmost: { NSWorkspace.shared.frontmostApplication?.processIdentifier })
            // The window itself comes above the others a moment after its app is reported in front;
            // a pointer step checks what is under its point before then.
            if current.parents.isEmpty { await FrontReport.waitOnTop(current.target.id, pid: current.app.pid) }
        }
        // The person had other work in front, and the window was just brought back for this
        // step. Coordinate steps still check the live window against the observation, where
        // each one lands, before any input; this app's later steps take the front too, so a
        // background look cannot leave it behind the person's work again.
        if inBackground, front, disturbed, actions.contains(where: \.usesCoordinates) {
            session?.delivery = .foreground
        }
        let bounds: CGRect
        do { bounds = try access.validate(current.target, app: current.app, requireFrontmost: frontCheck) }
        catch { throw SharedDesktop.yielding(error) }
        try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
        if actions.contains(where: \.usesCoordinates), observation.imageDigest == nil {
            throw UseError("image_required", "Coordinates require an observation with an image. Use accessible refs, or observe with include_image true.", next: "observe")
        }
        // Text typed while a secure field is on screen can land in it: the person confirms
        // this exact app before a password or code they gave reaches it. Nothing is sent first.
        if current.records.contains(where: \.protected), actions.contains(where: \.entersText),
           WebBrowser.contains(bundleID: current.app.bundleID, info: current.app.app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:]) {
            throw UseError("protected_input", "Web pages take a password or code only in OpenWork's browser, which confirms the exact site. Use it, or take over here; nothing was sent.", next: "human_takeover")
        }
        if current.records.contains(where: \.protected), actions.contains(where: \.entersText),
           credentialApproval != current.app.bundleID {
            return text(["ok": false, "code": "credential_approval_required", "app": current.app.app.localizedName ?? current.app.bundleID,
                "app_id": current.app.bundleID, "dispatched": false, "next": "observe",
                "message": "This window has a password field. The person confirms this app before anything is typed; nothing was sent."])
        }
        // Typing with no observed text field goes to the app's own editor (text on a canvas),
        // which accessibility cannot name; the editor is checked before every character. A
        // password or code the person confirmed goes only into a field that can be named.
        let editorTyping = current.focus == nil && actions.first.map { if case .type = $0 { return true }; return false } == true
        // The step that types into the editor: the first, or one whose re-read after a click found no listed focus.
        var editorStep = editorTyping ? 0 : -1
        if editorTyping, credentialApproval != nil {
            throw UseError("protected_input", "A password or code goes only into a field the computer can identify. Nothing was sent.", next: "human_takeover")
        }
        // Focused input names no field, so it never carries a password or code.
        if credentialApproval != nil, actions.contains(where: { if case .focused = $0 { return $0.entersText }; return false }) {
            throw UseError("protected_input", "A password or code goes only into a field the computer can identify, never with target focused. Nothing was sent.", next: "human_takeover")
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
        // Opening a file hands it to the app: the person approves the exact file first.
        var typeNote: String?
        if let file = actions.lazy.compactMap({ action -> URL? in if case .openFile(let url) = action { return url }; return nil }).first {
            guard actions.count == 1 else {
                throw UseError("open_file_alone", "Open a file as its own step. Nothing was sent.", next: "observe")
            }
            // A type the app does not declare is refused before anything is sent, so the agent converts it.
            switch FileTypeCheck.of(file, app: current.app.name, info: current.app.app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:]) {
            case .unsupported(let message): throw UseError("file_type_unsupported", message, next: "correct_request")
            case .note(let note): typeNote = note
            case .fits: break
            }
            guard let fileApproval, fileApproval == [file.path] else {
                return text(["ok": false, "code": "files_approval_required", "files": [file.path],
                    "app": current.app.name, "dispatched": false, "next": "observe",
                    "message": "Opening a file hands it to the app. The person is asked first; nothing was sent."])
            }
        }
        // Moving the window makes every observed coordinate stale: it is its own step, and only
        // for the session's own window, never a dialog over it.
        if actions.contains(where: { if case .arrange = $0 { return true }; return false }) {
            guard actions.count == 1 else { throw UseError("arrange_alone", "Arrange a window as its own step. Nothing was sent.", next: "observe") }
            guard current.parents.isEmpty else { throw UseError("dialog_open", "Close the dialog before arranging the window. Nothing was sent.", next: "observe") }
        }
        // The agent's own clipboard: copy, cut and paste run as their own step, and a paste
        // uses only what the agent copied in this chat, never the person's clipboard.
        if let step = actions.lazy.compactMap(\.clipboard).first {
            guard actions.count == 1 else {
                throw UseError("clipboard_alone", "Copy, cut or paste as its own step. Nothing was sent.", next: "observe")
            }
            if step == .paste, !clipboard.canPaste {
                throw AgentClipboard.nothingCopied
            }
        }
        // Saving writes a file for the app from its open Save sheet; the organization's file rule decides whether anyone is asked.
        if let (file, replace) = actions.lazy.compactMap({ action -> (URL, Bool)? in if case .saveAs(let url, let replace) = action { return (url, replace) }; return nil }).first {
            guard actions.count == 1 else {
                throw UseError("save_as_alone", "Save as its own step. Nothing was sent.", next: "observe")
            }
            guard access.saveNameField(current.target) != nil else {
                throw UseError("save_panel_required", "save_as fills the app's open Save or Export sheet. Open it from the app (such as File > Save or Export), observe it, then try again. Nothing was sent.", next: "observe")
            }
            try FileHandoff.refuseReplacing(file, replace: replace)
            guard let fileApproval, fileApproval == [file.path] else {
                return text(["ok": false, "code": "files_approval_required", "files": [file.path], "save": true,
                    "app": current.frontApp.name, "dispatched": false, "next": "observe",
                    "message": "Saving writes this file for the app once the organization's file rule allows it; nothing was sent."])
            }
        }
        // Picking a file in an Open, Place or Insert panel hands it to the app: the organization's rule decides.
        if let file = actions.lazy.compactMap({ action -> URL? in if case .openInPanel(let url) = action { return url }; return nil }).first {
            guard actions.count == 1 else {
                throw UseError("open_in_panel_alone", "Pick a file in a panel as its own step. Nothing was sent.", next: "observe")
            }
            guard OpenPanelRules.isOpenPanel(kind: current.dialogKind, saveField: access.saveNameField(current.target) != nil,
                defaultButton: access.defaultButton(current.target).flatMap { access.attribute($0, kAXTitleAttribute) as? String }) else {
                throw UseError("open_panel_required", "open_in_panel picks a file in the app's open Open, Place, Insert or Attach panel. Open it from the app (such as File > Place or Insert > Picture), observe it, then try again. Nothing was sent.", next: "observe")
            }
            guard let fileApproval, fileApproval == [file.path] else {
                return text(["ok": false, "code": "files_approval_required", "files": [file.path], "open": true,
                    "app": current.frontApp.name, "dispatched": false, "next": "observe",
                    "message": "Choosing this file hands it to the app once its path is approved; nothing was sent."])
            }
        }
        session?.observation = nil; session?.focus = nil; session?.lastUsed = now
        if let intent { controls.narrate(intent) }
        session?.receiptInputs[requestID] = fingerprint
        session?.receipts[requestID] = ["ok": false, "code": "action_interrupted", "request_id": requestID, "next": "observe"]
        var deadline = now + 30
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
            // pauses the step only once they are working in the agent's app.
            if front || NSWorkspace.shared.frontmostApplication?.processIdentifier == current.frontApp.pid {
                throw SharedDesktop.interrupted
            }
        }
        var progress = BatchProgress(actions: actions.map(\.name))
        var fileAlert: [String: Any]?
        // Watch for the app's reaction from the first event on, so the wait
        // after input ends when the app has finished changing.
        let activity = actions.contains(where: \.changesWindow) ? AXActivity(pid: current.app.pid, clock: clock) : nil
        defer { activity?.stop() }
        let windowsBefore = access.windowChanges(current.app)
        var focus = current.focus
        // A click or focus step of this batch, or its typing into the app's editor, already chose what
        // has the keyboard: typing and editing keys after it may go there (`BatchContinuation.goesToEditor`).
        var clicked = false
        // A design app that draws its own text editor reports no focus: after the agent's own click,
        // here or as the last input of the previous act with no input of the person's since, typing
        // goes to its key window (`BatchContinuation.canvasText`).
        let designApp = InputDelivery.takesToolKeys(info: current.app.app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:])
        let clickedBefore = current.lastClick.map { !personInterrupted(since: $0) } == true
        session?.lastClick = nil
        var lastWasClick = false
        // Whether the design app showed a text edit session before the agent's click, and once typing began.
        var editBefore: Bool?
        var editSession: [String: Any]?
        func canvasText() -> Bool {
            designApp && credentialApproval == nil && (clicked || clickedBefore && !progress.hasInput)
        }
        // What each expect step checked, and whether it held; never a value.
        var checks: [[String: Any]] = []
        var activated = false
        var primed = false
        var needsObservation = false
        // The observed controls, refreshed when pacing confirms one that moved.
        var records = current.records
        var failure: UseError?
        var uncertain = false
        var savedFile: [String: Any]?
        var index = 0
        // Typing the person's input paused partway: the text still to type, the field's
        // selection before the step's first character, and what went in before the pause.
        var resumeText: String?
        var typingStart: CFRange?
        // Its own window in front, never a dialog of another process over it: real input,
        // bound to that window by the gate for the whole batch. The one dialog it reaches is
        // the app's own file panel, for a save_as or open_in_panel step.
        let realInput = front && current.mode == .control && ((current.realInput || asksReal) && current.parents.isEmpty || panelKeys)
        if realInput {
            try RealInputGate.shared.arm(pid: current.app.pid, window: current.target.id,
                panels: panelKeys ? AppIdentity.filePanelServices(for: current.app.pid) : [])
        }
        defer { if realInput { RealInputGate.shared.abandon() } }
        var typedBefore = ""
        var pausedForPerson = false
        steps: while index < actions.count {
            let action = resumeText.map(Action.type) ?? actions[index]
            do {
                // A shortcut with no observed field or control to type into, such as Command-S on a
                // canvas, runs as the app's own menu command for it when there is one. A Command
                // shortcut the menus do not list, such as one Blender draws in its own menus, goes
                // to the app as a key; blocked chords never get this far.
                let menuOnly = NativeKey.isMenuShortcut(action)
                let shortcutMenu = focus == nil || menuOnly ? InputDelivery.menuForShortcut(action, in: access.menuCatalog(current.app).entries) : nil
                let action = shortcutMenu.map { Action.menu($0) } ?? action
                // An expect step sends nothing: it reads the live state and stops the batch when a check
                // does not hold. What the next step needs is still read back before that step runs.
                if case .expect(let expectation) = action {
                    try checkInput()
                    let results = try await evaluate(expectation, records: records, current: current, background: background)
                    checks += results.map { ["step": index, "check": $0.check, "ok": $0.ok] }
                    if let failed = Expectation.failure(results) { throw failed }
                    progress.dispatched(path: "expected")
                    index += 1
                    continue steps
                }
                // Drawing: drags in a row are strokes on the same canvas, sent in one call while no
                // window opens or closes. Each still lands only in the selected window.
                let followsStrokes = Action.isStroke(action) && index > 0 && actions[..<index].allSatisfy(Action.isStroke)
                try checkInput()
                if followsStrokes, access.windowChanges(current.app).opened(since: windowsBefore) {
                    throw UseError("observation_required", "A window opened or closed after the last stroke. Observe before drawing more.", next: "observe")
                }
                // After a step that may have changed the view or focus, the next step runs only
                // when what it needs reads back as a fresh observation would show it.
                // A wait sends nothing: the step after it reads back instead, with the app given that time.
                if !followsStrokes, BatchContinuation.need(action) != .later, needsObservation || action.usesCoordinates && progress.hasInput {
                    switch try await readyToContinue(action, records: records, current: current, windowsBefore: windowsBefore, bounds: bounds,
                        pacing: pacing, background: background, credentialApproval: credentialApproval, afterClick: clicked,
                        canvasText: canvasText(), check: check) {
                    case .stop:
                        throw UseError("observation_required", "The preceding step may have changed the view or focus. Observe before executing the remaining steps.", next: "observe")
                    case .control(let live):
                        if let live, let at = records.firstIndex(where: { $0.ref == live.ref }) { records[at] = live }
                    case .keyboard(let live):
                        focus = live
                        if live == nil { editorStep = index }
                    case .pointer: break
                    }
                    needsObservation = false
                }
                // Between steps, bring the window back if something else came to the front.
                // Before any input, the window must still match the observation; after it,
                // each step re-validates the field or control it uses.
                if index > 0, try await shareDesktop(current, returns: &returns, since: moment, deadline: deadline, front: front) { disturbed = true }
                try checkWindow()
                try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
                var pointerTarget: AXUIElement?
                // A step on an observed control or the open file panel re-checks exactly that right
                // before input: the rest of the window, such as a panel's file list, may change.
                if !followsStrokes, !action.checksOwnTarget, action.usesCoordinates || (policy == .desktop && index == 0) || (disturbed && !progress.hasInput) {
                    let live = try await access.read(current.target, check: check)
                    // The helper bringing the window forward moves keyboard focus by itself: after
                    // its own raise only the content must match. Keys still check focus before they send.
                    // A pointer step checks the image where it lands instead, and what is under the point.
                    guard try access.captureDigest(live) == observation.stateDigest
                            || disturbed && (try access.captureDigest(live, focus: false)) == observation.contentDigest
                            || action.usesCoordinates else {
                        throw UseError("stale_observation", "The observed window content or focus changed.", next: "observe")
                    }
                    if action.usesCoordinates {
                        let points: [CGPoint]
                        switch action {
                        case .move(let p), .click(let p, _, _), .scroll(let p, _, _), .rightClick(let p), .hold(let p, _): points = [p]
                        case .drag(let path): points = path
                        default: throw UseError("invalid_arguments", "This action has no coordinates.")
                        }
                        // Scrolling again after this batch's own scroll or drag moves the same view on:
                        // what changed under the point is the agent's own doing (a map panned, a list
                        // scrolled), so no new image is taken. What is at the point is still checked below.
                        if !(BatchContinuation.continuesScroll(action, after: actions[..<index]) && progress.hasInput) {
                            let captured = try await observationImage(current, bounds: bounds, state: live,
                                requireFrontmost: frontCheck, check: check)
                            guard access.imageDigest(captured.0) == observation.imageDigest
                                    || ImageRegions.unchanged(observation.image, captured.0, around: points) else {
                                throw UseError("stale_observation", "The window image changed where this step lands. Observe before coordinate input.", next: "observe")
                            }
                        }
                        pointerTarget = try access.checkHit(observation.screenPoint(points[0]), target: current.target, app: current.app, background: background || !current.parents.isEmpty)
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
                if background, ["key", "type", "enter_value"].contains(action.name), !primed {
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
                // After this batch's own click, typing and editing keys with no listed text field go to the app's editor.
                if editorStep != index, BatchContinuation.goesToEditor(action, afterClick: clicked,
                    focus: focus.map { ($0.protected, $0.textField) }, credentialGiven: credentialApproval != nil) {
                    editorStep = index; focus = nil
                }
                if resumeText == nil, case .type = action {
                    typedBefore = ""
                    typingStart = focus.flatMap { $0.protected ? nil : PersonPlace.selection($0.element) }
                }
                session?.actionCount += 1
                var copiedBefore: Int?
                switch action.clipboard {
                case .paste?: try clipboard.preparePaste()
                case .copy?, .cut?: copiedBefore = clipboard.willCopy()
                case nil: break
                }
                // What was at a save's path before Save, so only a file written by this step counts.
                let saving: (file: URL, before: FileHandoff.Stamp?, since: Date)? = {
                    if case .saveAs(let file, _) = action { return (file, FileHandoff.stamp(file), Date()) }; return nil
                }()
                // The window under an Open panel before the press: a chosen file shows as a change in it.
                var choosing: (window: WindowTarget, title: String?, content: Data?, windows: Set<UInt32>)?
                if case .openInPanel = action, let window = current.parents.first?.target {
                    let state = try? await access.read(window, budget: AXReadBudget(seconds: 0.5), check: check)
                    choosing = (window, access.attribute(window.element, kAXTitleAttribute) as? String,
                        state.flatMap { try? access.captureDigest($0, focus: false) }, access.windowChanges(current.frontApp).windows)
                }
                if designApp, case .click = action, actions[(index + 1)...].contains(where: { switch $0 { case .type, .focused: return true; default: return false } }) {
                    editBefore = access.editSession(in: current.target) != nil
                }
                var path = try await input.execute(action, app: current.app, target: current.target, lease: observation,
                    access: access, records: records, focus: focus, pointerTarget: pointerTarget,
                    // A dialog's input is addressed to its app in the background, except a file panel's real
                    // input: macOS's panel process takes only that, with the window in front.
                    check: checkInput, checkWindow: checkWindow, background: (background || !current.parents.isEmpty) && !(realInput && panelKeys), editorTyping: editorStep == index,
                    clickToFocus: FocusStep.clicks(in: current.mode), canvasText: canvasText(), realInput: realInput, feedback: { [weak self] feedback in
                        guard let self, self.session?.id == id else { return }
                        self.controls.inputFeedback(feedback)
                    })
                uncertain = path != "waited"
                if path == "canvas_text" { editSession = ["before_click": editBefore.map { $0 as Any } ?? NSNull(), "while_typing": true] }
                if case .focused = action, designApp, editBefore != nil {
                    // Read again after the step: what the before/after pair of this edit session showed.
                    editSession = ["before_click": editBefore.map { $0 as Any } ?? NSNull(), "after_step": access.editSession(in: current.target) != nil]
                }
                if editorStep == index, case .type = action { clicked = true }
                if case .arrange = action {
                    // Remember the person's frame once, and where this arrange left the window.
                    var placement = session?.placement ?? WindowArrangement.Placement(window: current.target.element, original: bounds)
                    placement.arranged = WindowArrangement.frame(of: current.target.element)
                    session?.placement = placement
                    // The agent's own layout stands: the window is not put beside OpenWork again.
                    session?.follow?.agentPlaced()
                }
                if let copiedBefore {
                    // Copied once the app changed the clipboard; nothing of it is returned.
                    path = "copy_unconfirmed"
                    for _ in 0..<10 {
                        if clipboard.didCopy(since: copiedBefore) { path = action.clipboard == .cut ? "cut" : "copied"; break }
                        try check()
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                } else if action.clipboard == .paste {
                    path = "pasted"
                }
                if case .openFile = action {
                    // A success from Launch Services is not proof: the file counts as opened once the
                    // app shows it, in a new document window or this one retitled for it, within a few
                    // seconds. An alert instead, such as "could not be opened", is a refusal.
                    let title = current.target.title
                    path = "file_open_unconfirmed"
                    for _ in 0..<30 {
                        try check()
                        let documentOpened = !access.windowChanges(current.app).windows.subtracting(windowsBefore.windows).isEmpty
                        let retitled = (access.attribute(current.target.element, kAXTitleAttribute) as? String).map({ $0 != title }) == true
                        let alert = access.frontAlert(current.app)
                        if documentOpened || retitled || alert != nil {
                            path = FileOpenCheck.outcome(alert: alert, documentWindowOpened: documentOpened, retitled: retitled)
                            fileAlert = alert; break
                        }
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                }
                if case .openInPanel = action {
                    // A pressed Open is not proof: the file counts as chosen once the panel closed and the
                    // app shows it, in a new window, a retitle or changed content. An alert refutes it.
                    path = "file_choice_unconfirmed"
                    for attempt in 0..<50 {
                        try check()
                        let alert = access.frontAlert(current.frontApp)
                        let panelOpen = access.dialogOpen(current.target, app: current.app)
                        // The window's content is read less often: it is the slowest sign to read.
                        var changed = false
                        if !panelOpen, attempt % 5 == 4, let choosing, let before = choosing.content,
                           let state = try? await access.read(choosing.window, budget: AXReadBudget(seconds: 0.5), check: check) {
                            changed = (try? access.captureDigest(state, focus: false)).map { $0 != before } == true
                        }
                        if let outcome = OpenPanelRules.outcome(panelOpen: panelOpen, alert: alert,
                            windowOpened: choosing.map { !access.windowChanges(current.frontApp).windows.subtracting($0.windows).isEmpty } == true,
                            retitled: choosing.map { (access.attribute($0.window.element, kAXTitleAttribute) as? String) != $0.title } == true,
                            contentChanged: changed) {
                            path = outcome; fileAlert = alert; break
                        }
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                }
                if let saving {
                    // A pressed Save is not proof: the file counts as saved once it is on disk, written after Save.
                    path = "file_save_unconfirmed"
                    for _ in 0..<50 {
                        try check()
                        if let saved = FileHandoff.saved(saving.file, before: saving.before, since: saving.since) {
                            path = "file_saved"; savedFile = ["path": saving.file.path, "bytes": saved.bytes]; break
                        }
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                }
                try check()
                progress.dispatched(path: shortcutMenu == nil ? path : "menu_for_shortcut"); uncertain = false
                lastWasClick = { switch action { case .click, .focus: return true; default: return false } }()
                let dispatchedAt = now
                // The press already ran: outline the control only where it still is.
                controls.showAction(action, records: records, live: { [access] record in access.frame(record.element, within: 0.05) })
                if case .menu = action, let menu = input.lastMenu {
                    controls.showMenu(titleFrame: menu.titleFrame, path: menu.path, shortcut: menu.shortcut,
                        menuBarShowing: NSWorkspace.shared.frontmostApplication?.processIdentifier == current.app.pid)
                }
                switch action {
                case .click:
                    focus = current.records.first { record in record.textField && pointerTarget.map { CFEqual($0, record.element) } == true }
                    needsObservation = focus == nil
                    clicked = true
                case .enterValue:
                    // The value was committed: what has the keyboard now is read again before more keys.
                    focus = nil; needsObservation = true
                case .focus(let ref):
                    // The focused control is the next keys' target: exactly, when it is the listed text field
                    // itself; otherwise (a field editor, a value field drawn by the app) the editor rule.
                    let live = try? access.focusedEditor(target: current.target, app: current.app, requireFront: !background)
                    focus = records.first { record in record.ref == ref && record.textField && live.map { CFEqual($0, record.element) } == true }
                    clicked = true
                case .press(let ref):
                    focus = records.first { $0.ref == ref && $0.textField }
                    needsObservation = focus == nil
                case .menu:
                    focus = nil; needsObservation = true
                case .setValue(let ref, _):
                    // A filled field gets the keyboard, so Enter can submit it as a person would.
                    if let field = records.first(where: { $0.ref == ref && $0.textField }), access.refocus(field) { focus = field }
                    else if focus?.ref != ref { focus = nil }
                case .move, .scroll, .drag, .rightClick, .hold, .showMenu: needsObservation = true
                case .key: needsObservation = action.endsFocusSequence
                default: break
                }
                if policy == .embedded, action.changesWindow, index + 1 < actions.count {
                    if pacing.mode != .fast {
                        // Let the app finish reacting before the next step looks at it.
                        _ = try await InputSettle.wait(since: dispatchedAt, lastActivity: { activity?.last ?? 0 }, now: { self.now },
                            check: check, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
                    } else if !needsObservation {
                        try await Task.sleep(nanoseconds: 50_000_000)
                        try check()
                    }
                }
                resumeText = nil; index += 1
            } catch let error where SharedDesktop.isPersonInput(error) {
                // The person clicked or typed: nothing more goes out until they are idle, and a
                // step that may have landed is never sent again.
                let landed = (error as? InputFailure)?.mayHaveActed == true
                var resumption = SharedDesktop.resumption(of: action, mayHaveActed: landed, typed: input.typedCharacters)
                if case .typeRest(let sent, _) = resumption, focus?.protected != false {
                    // A password, or text on a canvas with no field to check the caret in.
                    resumption = .stop(SharedDesktop.pausedStep("Typing stopped after \(typedBefore.count + sent.count) characters; the rest was not typed."))
                }
                if case .stop(let calm) = resumption {
                    failure = calm; uncertain = landed || resumeText != nil
                    yieldToPerson(since: moment)
                    break steps
                }
                do {
                    let waitedBefore = waitedForPerson
                    try await waitForPerson(current, since: moment)
                    _ = try await aroundPerson(current) {
                        moment = ProcessInfo.processInfo.systemUptime; returns = 0
                        return try await self.shareDesktop(current, returns: &returns, since: moment, front: front)
                    }
                    // Before any further input the live window is read again and must still
                    // match the observation (focus aside, which the person may have moved).
                    disturbed = true
                    // The pause does not count against the step's own time.
                    deadline += waitedForPerson - waitedBefore
                } catch {
                    failure = (error as? UseError) ?? SharedDesktop.busy; uncertain = landed || resumeText != nil
                    break steps
                }
                pausedForPerson = true
                switch resumption {
                case .typeRest(let sent, let rest):
                    let typed = typedBefore + sent
                    // Only in the same field, with the caret right after the agent's own text.
                    guard let field = focus,
                          (try? access.checkFocus(field, target: current.target, app: current.app, requireField: true, requireFront: !background)) != nil,
                          SharedDesktop.caretUnmoved(start: typingStart, sent: typed, now: PersonPlace.selection(field.element)) else {
                        failure = SharedDesktop.pausedStep("Typing stopped after \(typed.count) characters; the field or its caret changed, so the rest was not typed.")
                        uncertain = true
                        break steps
                    }
                    typedBefore = typed; resumeText = rest
                case .done:
                    progress.dispatched(path: "targeted_input"); uncertain = false
                    resumeText = nil; index += 1
                case .resend, .stop: break
                }
            } catch let interrupted as InputFailure {
                failure = SharedDesktop.yielding(interrupted.cause); uncertain = interrupted.mayHaveActed || resumeText != nil
                if pausedForPerson, let calm = failure { failure = SharedDesktop.afterPause(calm) }
                break
            } catch {
                failure = (SharedDesktop.yielding(error) as? UseError) ?? UseError("action_interrupted", "Input was interrupted. Inspect the receipt; do not repeat it.", next: "human_takeover")
                if pausedForPerson, let calm = failure { failure = SharedDesktop.afterPause(calm) }
                if resumeText != nil { uncertain = true }
                break
            }
        }
        if progress.hasInput, current.mode == .control { session?.lastInput = realInput ? .real : .targeted }
        // After the app has taken the input in, the person's pointer goes back. Anything
        // held back or unconfirmed at the window server ends the step as uncertain.
        var realRoute: [[String: Any]] = []
        if realInput {
            if let error = await RealInputGate.shared.finish(), failure == nil { failure = error; uncertain = true }
            input.restorePointer()
            // Where each real event went, for a step that failed or worked in a file panel.
            let trace = RealInputGate.shared.takeTrace()
            if failure != nil || panelKeys {
                realRoute = RealInputRoute.describe(trace, app: current.app.pid, bundle: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier })
            }
        }
        var settled: Bool?
        if progress.hasInput || uncertain {
            session?.baseline = ActionBaseline(generation: current.generation, stateDigest: observation.stateDigest, imageDigest: observation.imageDigest,
                moved: actions.contains { switch $0 { case .drag, .scroll: return true; default: return false } })
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
        if lastWasClick, session?.id == id { session?.lastClick = ProcessInfo.processInfo.systemUptime }
        var receipt = progress.receipt(requestID: requestID, failure: failure, uncertain: uncertain, detailed: policy == .embedded)
        if let settled { receipt["settled"] = settled }
        if let savedFile { receipt["saved_file"] = savedFile }
        if let editSession { receipt["edit_session"] = editSession }
        let windowsAfter = access.windowChanges(current.app)
        if settled != nil, let changes = windowsBefore.diff(windowsAfter, target: current.target.id) {
            receipt["window_changes"] = changes
        }
        if progress.hasInput {
            session?.openedByLastAction = windowsAfter.windows.subtracting(windowsBefore.windows)
            // An app's own panel window (QuickTime's launch Open window) can be the session's window too.
            session?.windowsBeforeInput = (windowsBefore.windows.union(windowsBefore.panels), now)
            // A step that closed its own window waits a moment for the app's new one.
            let closedOwn = !windowsAfter.windows.union(windowsAfter.panels).contains(current.target.id) && current.parents.isEmpty
            if let replaced = await followReplacement(id, settle: closedOwn ? WindowReplacement.settle : 0) { receipt["window_replaced"] = replaced }
        }
        receipt["delivery"] = (background ? InputDelivery.background : .foreground).rawValue
        if !realRoute.isEmpty { receipt["real_input_route"] = realRoute }
        if panelKeys, !input.goToTrace.isEmpty { receipt["go_to_trace"] = input.goToTrace }
        if let typeNote { receipt["type_note"] = typeNote }
        if let fileAlert { receipt["file_alert"] = fileAlert }
        if !checks.isEmpty { receipt["checks"] = checks }
        var desktop = desktopBefore.changes(to: DesktopState.now())
        if current.follow != nil { desktop["followed"] = current.followed }
        receipt["desktop"] = desktop
        let waited = Int((waitedForPerson * 1_000).rounded())
        if waited > 0 { receipt["waited_for_person_ms"] = waited }
        if session?.id == id { session?.receipts[requestID] = receipt }
        return text(receipt)
    }
    /// An expect step's checks against the live window, in `Expectation.checks` order. Refs must
    /// come from the observation; a secure field's value is never read.
    private func evaluate(_ expectation: Expectation, records: [ElementRecord], current: Session, background: Bool) async throws -> [(check: String, ok: Bool)] {
        func record(_ ref: String) throws -> ElementRecord {
            guard let record = records.first(where: { $0.ref == ref }) else { throw UseError("unknown_ref", "Use an element ref from the current observation.", next: "observe") }
            return record
        }
        for ref in expectation.refs { _ = try record(ref) }
        if let ref = expectation.valueRef { try FocusStep.checkComparable(protected: try record(ref).protected) }
        func present(_ record: ElementRecord) -> Bool {
            access.attribute(record.element, kAXRoleAttribute) != nil && access.isInWindow(record.element, target: current.target)
        }
        let editor = expectation.focused == nil ? nil : try? access.focusedEditor(target: current.target, app: current.app, requireFront: !background)
        var results: [(check: String, ok: Bool)] = []
        for check in expectation.checks {
            let ok: Bool
            switch check {
            case "focused":
                switch expectation.focused {
                case .ref(let ref)?: ok = try editor.map { access.isWithin($0, try record(ref).element) } == true
                default: ok = editor.map(access.isTextEditor) == true
                }
            case "front":
                let front = access.isFocusedWindow(current.target, app: current.app)
                    && (background || NSWorkspace.shared.frontmostApplication?.processIdentifier == current.frontApp.pid)
                ok = front == expectation.front
            case "enabled":
                let control = try record(expectation.enabled!)
                ok = present(control) && (access.attribute(control.element, kAXEnabledAttribute) as? Bool) != false
            case "exists": ok = present(try record(expectation.exists!))
            case "gone": ok = !present(try record(expectation.gone!))
            case "dialog": ok = (await access.dialog(over: current.target, app: current.app) != nil) == expectation.dialog
            case "value":
                let field = try record(expectation.valueRef!)
                ok = present(field) && Expectation.valueMatches(access.attribute(field.element, kAXValueAttribute), expectation.valueEquals ?? "")
            default:
                ok = (access.attribute(current.target.element, kAXTitleAttribute) as? String)?.localizedCaseInsensitiveContains(expectation.titleContains ?? "") == true
            }
            results.append((check, ok))
        }
        return results
    }
    private enum Readiness { case stop, control(ElementRecord?), keyboard(ElementRecord?), pointer }
    /// After a step that may have changed the view or focus, the batch's next step still runs
    /// in the same call when nothing opened over the window and what it needs reads back as a
    /// fresh observation would show it (`BatchContinuation`): a press, set_value or menu
    /// command's control (`BatchContinuation.sameControl`); for keys and typing, a focused
    /// control or text field in the window, never a secure one; for a pointer step, nothing
    /// here (it compares the window image where it lands). What is not ready yet, such as a
    /// field a menu command is still focusing, is read again for `BatchContinuation.reread`,
    /// or until retry_ms with wait_retry. Anything else needs an observation.
    private func readyToContinue(_ action: Action, records: [ElementRecord], current: Session, windowsBefore: WindowChanges, bounds: CGRect,
                                 pacing: BatchPacing, background: Bool, credentialApproval: String?, afterClick: Bool = false,
                                 canvasText: Bool = false, check: () throws -> Void) async throws -> Readiness {
        guard policy == .embedded, let need = BatchContinuation.need(action), need != .later else { return .stop }
        // An app that takes real input lists no focused field: its keys and typing go to its key
        // window, as on the first step, once nothing opened over it and no secure input is on.
        if current.realInput, case .keyboard = need {
            guard windowsBefore.diff(access.windowChanges(current.app), target: current.target.id) == nil, access.personPrompt() == nil,
                  (try? access.checkKeyWindow(target: current.target, app: current.app, requireFront: true)) != nil else { return .stop }
            return .keyboard(nil)
        }
        var observed: ElementRecord?
        if case .control(let ref) = need {
            guard let record = records.first(where: { $0.ref == ref }) else { return .stop }
            observed = record
        }
        // The wait modes already let the app settle after the previous step.
        if pacing.mode == .fast { try await Task.sleep(nanoseconds: 50_000_000); try check() }
        let deadline = now + max(pacing.retry, BatchContinuation.reread)
        while true {
            // Nothing waits past a window, dialog, menu or system prompt that opened. Keys and typing
            // may run past a window that opened beside the session's while it keeps the keyboard.
            let changes = windowsBefore.diff(access.windowChanges(current.app), target: current.target.id)
            guard BatchContinuation.runsPast(changes, need: need, sessionHasKeyboard: changes != nil && access.isFocusedWindow(current.target, app: current.app)),
                  access.personPrompt() == nil else { return .stop }
            if await access.openMenu(of: current.app) != nil { return .stop }
            if await access.dialog(over: current.target, app: current.app) != nil { return .stop }
            switch need {
            case .menu: return .control(nil)
            // Focused input checks the key window itself when it sends.
            case .pointer, .keyWindow: return .pointer
            case .control, .keyboard, .later: break
            }
            var live: WindowState?
            do { live = try await access.read(current.target, check: check) }
            catch is CancellationError { throw CancellationError() }
            catch { try check() }
            if let live, case .keyboard(let field) = need, !live.truncated {
                let focused = live.focusRecord
                let typing: Bool = { if case .type = action { return true }; return false }()
                let shortcut: Bool = { if case .key(let key, let flags) = action { return InputDelivery.sendsToKeyWindow(key, flags) }; return false }()
                // A design app's editing or tool key goes to what has the keyboard in the window, as on the first step.
                let editingKey: Bool = { if case .key(let key, let flags) = action { return NativeKey.isEditingKey(key, flags) }; return false }()
                let designKey: Bool = {
                    guard case .key(let key, let flags) = action, editingKey || NativeKey.isToolKey(key, flags) else { return false }
                    return InputDelivery.takesToolKeys(info: current.app.app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary } ?? [:])
                }()
                switch BatchContinuation.keyboard(focused: focused.map { ($0.enabled, $0.protected, $0.takesTyping) }, field: field,
                    typing: typing, entersText: action.entersText, secureInput: IsSecureEventInputEnabled(),
                    protectedOnScreen: live.records.contains(where: \.protected) || !live.protectedFrames.isEmpty,
                    credentialConfirmed: credentialApproval == current.app.bundleID, credentialGiven: credentialApproval != nil, shortcut: shortcut,
                    designKey: designKey, editingKey: editingKey, afterClick: afterClick) {
                case .focus: return .keyboard(focused)
                case .keyWindow where (try? access.checkKeyWindow(target: current.target, app: current.app, requireFront: !background)) != nil:
                    return .keyboard(nil)
                // The same editor check as typing with no observed field: whatever has the keyboard in this
                // window. Delete and Backspace erase only editable text there.
                case .editor where (try? access.focusedEditor(target: current.target, app: current.app, requireFront: !background))
                        .map { typing || !field || access.isTextEditor($0) } == true:
                    return .keyboard(nil)
                // A design app's canvas text after this batch's click, where the app reports no focus.
                case .editor where typing && canvasText && BatchContinuation.canvasText(designApp: true, afterOwnClick: true, credentialGiven: false,
                        reported: access.reportedFocus(target: current.target, app: current.app))
                        && access.editSession(in: current.target).map({ session in (try? access.checkCanvasText(target: current.target, app: current.app,
                            requireFront: !background, reported: access.reportedFocus(target: current.target, app: current.app), session: session)) != nil }) == true:
                    return .keyboard(nil)
                case .editor, .keyWindow, .stop: break
                }
            } else if let live, let observed,
                      let same = live.records.first(where: { BatchContinuation.sameControl($0, observed, for: action, window: bounds) }) {
                return .control(same.with(ref: observed.ref))
            }
            // Not ready yet: the keyboard is still moving, or the control is briefly disabled or gone.
            guard now < deadline else { return .stop }
            try await Task.sleep(nanoseconds: pacing.mode == .waitRetry ? 100_000_000 : 50_000_000); try check()
        }
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
    private static let clicks: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    private static let interruptions: [CGEventType] = clicks + [.keyDown]
    /// When the person last produced physical input of this type, in uptime. The
    /// HID system state holds only device input, never the agent's process-targeted
    /// events. Reads only timing, with no permission beyond computer use's own.
    private func lastPersonInput(_ type: CGEventType) -> TimeInterval {
        // While a batch sends real input, the agent's own events reach the HID state too:
        // the gate tells the person's events from the agent's tagged ones.
        let gate = RealInputGate.shared
        let armed = gate.isArmed
        return RealInput.personInput(hid: ProcessInfo.processInfo.systemUptime - CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: type),
            untagged: armed ? gate.personInput(type) : nil, armed: armed)
    }
    private func personInterrupted(since start: TimeInterval) -> Bool {
        Self.interruptions.contains { SharedDesktop.personInterrupted(inputAt: lastPersonInput($0), since: start) }
    }
    /// A physical mouse button held down right now.
    private func personHoldsButton() -> Bool {
        [CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.hidSystemState, button: $0) }
    }
    /// In foreground control, takes the next gap in the person's typing or a held button.
    /// Someone writing in a field gets a real pause, for up to `typingDeferLimit`.
    private func takeGap(_ current: Session, deadline: TimeInterval? = nil, front: Bool? = nil) async throws {
        guard front ?? current.takesFront else { return }
        let typing = personTyping()
        if typing { momentTyping = true }
        let waited = try await SharedDesktop.takeGap(busy: {
            SharedDesktop.personBusy(keyAt: self.lastPersonInput(.keyDown), buttonDown: self.personHoldsButton(),
                now: ProcessInfo.processInfo.systemUptime, inField: typing)
        }, limit: typing ? SharedDesktop.typingDeferLimit : SharedDesktop.deferLimit, now: { self.now }, check: {
            try self.checkActive(current, deadline: deadline)
        }, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
        waitedForPerson += waited
    }
    /// The person is writing in a text field of the front app, or in OpenWork's composer.
    private func personTyping() -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return false }
        return SharedDesktop.personTyping(keyAt: lastPersonInput(.keyDown), now: ProcessInfo.processInfo.systemUptime,
            frontIsHost: front == Responsibility.hostPID, focusEditsText: { PersonPlace.focusEditsText(front) })
    }
    /// The person's click or key stopped the step, so the read that follows does not take
    /// the front again. Keys alone, from someone who was writing in a field, were meant for
    /// it: the front and their place go back as soon as the step ends.
    private func yieldToPerson(since start: TimeInterval) {
        session?.yielded = true
        handBack.interrupted(clicked: Self.clicks.contains { lastPersonInput($0) > start })
    }
    /// Brings the selected window to the front, remembering which app had it. A click
    /// or key of the person's while it comes forward stops whatever was to follow.
    private func takeFront(_ current: Session) async throws {
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let own = ProcessInfo.processInfo.processIdentifier
        // Where the person was, read once per moment before the agent's window comes forward.
        if handBack.takesAnew, let frontmost, frontmost != current.frontApp.pid, frontmost != own {
            personPlace = PersonPlace.read(frontmost)
        }
        // Taken from OpenWork, the front stays with the agent only while the person follows
        // this chat there; from another chat it goes back after the step, like from any app.
        // Following while typing in the composer, the window stays beside OpenWork and the
        // keys go back to the composer after each step (`typing`, `HandBack.immediate`).
        handBack.record(frontmost: frontmost, target: current.frontApp.pid, own: own,
            host: current.follow == nil || current.followed ? Responsibility.hostPID : 0,
            at: ProcessInfo.processInfo.systemUptime, typing: momentTyping,
            inField: personPlace?.pid == frontmost && personPlace?.inField == true)
        let started = ProcessInfo.processInfo.systemUptime
        do {
            try await SharedDesktop.acquire(now: { ProcessInfo.processInfo.systemUptime }, buttonDown: { self.personHoldsButton() },
                focus: { try await self.focusTarget(current) }, interrupted: { self.personInterrupted(since: $0) })
        } catch let error as UseError where error.code == SharedDesktop.interrupted.code {
            // A click may have landed in the agent's window: the front stays there. Keys
            // meant for the person's field send it back (`yieldToPerson`).
            yieldToPerson(since: started)
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
    /// Only once the person has shown they want it back (`HandBack.eachMoment`);
    /// until then the front stays with the agent's window and is handed back when
    /// the session closes. Taken from someone writing in a field, it goes back at once.
    private func scheduleHandBack() {
        handBackTimer?.invalidate(); handBackTimer = nil
        guard handBack.pid != nil, handBack.eachMoment else { return }
        let timer = Timer(timeInterval: handBack.immediate ? 0 : SharedDesktop.handBackDelay, repeats: false) { [weak self] _ in
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
        handFrontBack(current)
    }
    /// The person clicked or typed during the agent's moment: give them the front (keys meant
    /// for their field send it back there) and wait until they are idle, within what is left
    /// of this call's `busyLimit`. Take over and Stop end the wait as they end any step.
    private func waitForPerson(_ current: Session, since start: TimeInterval) async throws {
        yieldToPerson(since: start)
        handFrontBack(current)
        let started = ProcessInfo.processInfo.systemUptime
        let idle = try await SharedDesktop.waitForIdle(lastInput: { Self.interruptions.map { self.lastPersonInput($0) }.max() ?? -.infinity },
            buttonDown: { self.personHoldsButton() }, limit: personWaitLeft, now: { ProcessInfo.processInfo.systemUptime },
            check: { try self.checkActive(current) }, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
        let waited = ProcessInfo.processInfo.systemUptime - started
        personWaitLeft -= waited; waitedForPerson += waited
        guard idle else { throw SharedDesktop.busy }
    }
    /// Runs `attempt` again each time the person's click or key pauses it, once they are idle.
    private func aroundPerson<Value>(_ current: Session, _ attempt: () async throws -> Value) async throws -> Value {
        while true {
            let start = ProcessInfo.processInfo.systemUptime
            do { return try await attempt() }
            catch let error where SharedDesktop.isPersonInput(error) { try await waitForPerson(current, since: start) }
        }
    }
    /// Gives the front back to the person, from the end of a moment or during a pause.
    private func handFrontBack(_ current: Session) {
        // A click since the front was taken, even one that might be the agent's own,
        // means the person may be working in the agent's window; so do keys, unless
        // they were writing in a field before (`HandBack.take`).
        let immediate = handBack.immediate
        guard let pid = handBack.take(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                  target: current.frontApp.pid, lastKey: lastPersonInput(.keyDown),
                  lastClick: Self.clicks.map { lastPersonInput($0) }.max() ?? -.infinity),
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return }
        let place = personPlace?.pid == pid ? personPlace : nil
        personPlace = nil
        PersonPlace.restore(place, app: app)
        // They are writing: the read that follows looks without taking the front again.
        if immediate { session?.yielded = true }
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
            // An Open or Place panel that is a window of its own, which the app focused after the action returned.
            if next == nil, scope.dialogKind != .menu, scope.dialogKind != .filePanel { next = await access.focusedFilePanel(than: scope.target, app: scope.app) }
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
            // Each way once, read back after each; never keep stealing the front if a person intervenes.
            let app = AXUIElementCreateApplication(owner.pid)
            _ = try await WindowFront.bring(attempt: { way in
                switch way {
                case .raise:
                    _ = AXUIElementPerformAction(window.element, kAXRaiseAction as CFString)
                    _ = owner.app.activate(options: [])
                case .frontmost:
                    _ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                case .mainWindow:
                    _ = AXUIElementSetAttributeValue(window.element, kAXMainAttribute as CFString, kCFBooleanTrue)
                    _ = AXUIElementSetAttributeValue(window.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                    _ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                case .keyRecords:
                    _ = BackgroundFocus.post(pid: owner.pid, window: window.id, makeKey: true)
                    _ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                    _ = owner.app.activate(options: [])
                }
            }, inFront: { self.inFront(current) }, check: {
                guard self.session?.id == current.id, self.session?.generation == current.generation else { throw UseError("session_changed", "Control changed during focus. No input was dispatched.", next: "observe") }
            }, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
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
            if current.working != .background { try await focusTarget(current) }
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
    /// Whether the person follows this session now (`FollowAlong`); presence moves with it.
    @discardableResult
    private func refreshFollow(_ id: String) -> Bool {
        guard let current = session, current.id == id, current.mode == .control, var follow = current.follow else { return false }
        // A dialog is the agent's own doing: the session keeps following, or not, as it was.
        guard current.parents.isEmpty else { return current.followed }
        let followed = follow.follows(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier, host: Responsibility.hostPID,
            target: current.app.pid, shown: FollowAlong.onScreen(current.target.id))
        session?.follow = follow; session?.followed = followed
        if followed != current.followed { controls.layer(background: !followed && current.delivery == .background) }
        return followed
    }
    /// Puts the window beside OpenWork once per return to the chat, or in its tile when several
    /// agents work in view, unless it was placed since; closing the session puts it back, as
    /// after `arrange`. Only this session's own window moves.
    private func arrangeBeside(_ id: String) {
        guard let current = session, current.id == id, current.followed, current.parents.isEmpty, var follow = current.follow else { return }
        let frame = WindowArrangement.frame(of: current.target.element)
        let due = follow.arrangeNow(current: frame, arranged: current.placement?.arranged)
        session?.follow = follow
        let screens = WindowArrangement.visibleScreens(), host = WindowArrangement.hostWindow()
        let place = { (frame: CGRect) throws -> CGRect in
            guard let stage = follow.stage else { return try WindowArrangement.frame(.besideOpenWork, window: frame, screens: screens, host: host) }
            return try WindowArrangement.stage(count: stage.count, window: frame, screens: screens, host: host)[stage.slot]
        }
        guard due, let frame, let beside = try? place(frame),
              (try? WindowArrangement.apply(beside, to: current.target.element, check: { try self.checkActive(current) })) != nil else { return }
        var placement = current.placement ?? WindowArrangement.Placement(window: current.target.element, original: frame)
        placement.arranged = WindowArrangement.frame(of: current.target.element)
        session?.placement = placement
    }
    func close(stoppedByPerson: Bool = false) {
        // Windows the session arranged go back, unless the person has placed them since.
        if let placement = session?.placement { WindowArrangement.restore(placement) }
        clipboard.restore()
        giveBack(); handBack.reset()
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
