import AppKit
import QuartzCore

/// Who is acting, supplied by the trusted host when it launches this helper.
/// Display only: it never grants or changes access.
struct Presence {
    let name: String
    let color: NSColor

    /// `OPENWORK_COMPUTER_USE_PRESENCE` is JSON `{"name": "…", "color": "#rrggbb"}`.
    static func load(fallbackName: String = "OpenWork") -> Presence {
        let blue = NSColor(srgbRed: 0.27, green: 0.52, blue: 0.95, alpha: 1)
        let fallback = Presence(name: fallbackName, color: blue)
        guard let raw = ProcessInfo.processInfo.environment["OPENWORK_COMPUTER_USE_PRESENCE"], raw.utf8.count <= 4096,
              let value = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { return fallback }
        let name = (value["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let color = (value["color"] as? String).flatMap(hex) ?? blue
        return Presence(name: name.isEmpty ? fallback.name : String(name.prefix(32)), color: color)
    }

    static func hex(_ value: String) -> NSColor? {
        guard value.count == 7, value.hasPrefix("#"), let rgb = UInt32(value.dropFirst(), radix: 16) else { return nil }
        return NSColor(srgbRed: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }
}

/// Multiplayer-style presence for the selected window, in the acting agent's
/// color: a frame around the window, the agent's named cursor that springs to each dispatched input and narrates what it is doing, and a
/// pill over the window's close/minimize/zoom buttons with Take over, Continue
/// and Stop. Inputs are posted to the app, not the system pointer, so without
/// this the person cannot see the agent act. The frame and cursor never receive
/// events and every overlay is excluded from capture, so observations are unchanged.
@MainActor
final class AgentCursor {
    static let shared = AgentCursor()

    var onTakeOver: (() -> Void)?
    var onContinue: (() -> Void)?
    var onStop: (() -> Void)?

    private let presence = Presence.load()
    /// The embedded OpenWork host always shows presence; standalone clients opt in by passing one.
    private let enabled = SessionControls.embedded
        || ProcessInfo.processInfo.environment["OPENWORK_COMPUTER_USE_PRESENCE"] != nil
    private var window: NSWindow?
    private var badge: NSPanel?
    private var pill: PresencePill?
    private let outline = CAShapeLayer()
    private let trail = CAShapeLayer()
    private let cursor = CALayer()
    private let arrow = CAShapeLayer()
    private let tag = CALayer()
    private let tagText = CATextLayer()
    private let dots = CALayer()
    private var trailPoints: [CGPoint] = []
    private var cursorPoint: CGPoint?
    private var windowFrame: CGRect = .null
    private var windowID: CGWindowID = 0
    /// Background sessions: presence sits just above the selected window, so a
    /// window the person brings in front of it also covers the agent's cursor.
    private var layered = false
    private var appName = ""
    private var paused = false
    private var canContinue = false
    private var narration: String?
    private var resetTag: DispatchWorkItem?
    private var tracker: Timer?
    private var idle: DispatchWorkItem?
    private var hidden = false
    private var generation = 0
    /// Bumped by each input, so a menu replay never pulls the cursor back from a newer step.
    private var motion = 0

    private static let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    private var scale: CGFloat { NSScreen.main?.backingScaleFactor ?? 2 }

    /// Global Quartz coordinates (top-left origin) to Cocoa screen coordinates.
    private static func cocoa(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: (NSScreen.screens.first?.frame.maxY ?? 0) - rect.maxY, width: rect.width, height: rect.height)
    }
    private static func cocoa(_ point: CGPoint) -> CGPoint {
        CGPoint(x: point.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - point.y)
    }
    private func local(_ screenPoint: CGPoint) -> CGPoint? {
        guard let window else { return nil }
        let point = Self.cocoa(screenPoint)
        return CGPoint(x: point.x - window.frame.minX, y: point.y - window.frame.minY)
    }

    // MARK: Session lifecycle

    func begin(windowFrame frame: CGRect, windowID id: CGWindowID, appName name: String, layered: Bool = false) {
        guard enabled else { return }
        generation += 1
        let fresh = window == nil
        paused = false; canContinue = false; narration = nil; hidden = false
        windowID = id; appName = name; self.layered = layered
        if fresh { build() }
        window?.alphaValue = 1; badge?.alphaValue = 1
        place(frame)
        order()
        refreshPill()
        guard fresh, let window else { return }
        // Draw the frame in, then let the cursor pop in at the window's center.
        let draw = CABasicAnimation(keyPath: "strokeEnd")
        draw.fromValue = 0; draw.toValue = 1; draw.duration = 0.6
        draw.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        outline.add(draw, forKey: "draw")
        let rect = Self.cocoa(frame).offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
        arrive(at: CGPoint(x: rect.midX, y: rect.midY))
        say("\(presence.name) is here", busy: false, hold: 1.6)
        tracker = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
        if let tracker { RunLoop.main.add(tracker, forMode: .common) }
    }

    func setPaused(_ value: Bool, canContinue resumable: Bool) {
        guard window != nil else { return }
        let changed = paused != value || canContinue != resumable
        paused = value; canContinue = resumable
        guard changed else { return }
        CATransaction.begin(); CATransaction.setAnimationDuration(0.25)
        outline.lineDashPattern = value ? [10, 7] : nil
        outline.opacity = value ? 0.75 : 1
        arrow.opacity = value ? 0.5 : 1
        CATransaction.commit()
        stopThinking()
        say(value ? "\(presence.name) · waiting for you" : presence.name, busy: false, hold: nil)
        refreshPill()
        if value {
            // A small "over here" bounce, then stillness while the person works.
            let bounce = CAKeyframeAnimation(keyPath: "transform.translation.y")
            bounce.values = [0, 9, 0, 5, 0]; bounce.keyTimes = [0, 0.25, 0.5, 0.75, 1]; bounce.duration = 0.7
            cursor.add(bounce, forKey: "bounce")
            pill?.nudge()
        }
    }

    /// The agent's own short description of its next step, shown on its cursor.
    func narrate(_ text: String?) {
        guard window != nil else { return }
        let cleaned = text?.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        narration = cleaned.flatMap { $0.isEmpty ? nil : String($0.prefix(60)) }
        stopThinking()
        if let narration, !paused { say("\(presence.name) · \(narration)", busy: false, hold: 4) }
        refreshPill()
    }

    func feedback(action: String, phase: InputFeedback.Phase, screenPoint: CGPoint?, windowFrame frame: CGRect) {
        guard window != nil, !paused, phase != .uncertain else { return }
        motion += 1
        place(frame)
        stopThinking()
        let target = screenPoint.flatMap(local) ?? cursorPoint
        let travel = target.map { glide(to: $0) } ?? 0
        if action == "drag", let target {
            if phase == .down { trailPoints = [target] } else if phase == .move { trailPoints.append(target) }
            drawTrail(fading: phase == .up)
        }
        if phase == .down || (phase == .dispatched && screenPoint != nil && !["scroll", "type", "key", "set_value", "press", "menu"].contains(action)) {
            // Aim, then click: the ripple lands when the cursor arrives.
            let press = CAKeyframeAnimation(keyPath: "transform.scale")
            press.values = [1, 0.8, 1]; press.duration = 0.22
            press.beginTime = CACurrentMediaTime() + travel
            arrow.add(press, forKey: "press")
            if let target {
                DispatchQueue.main.asyncAfter(deadline: .now() + travel) { [weak self] in self?.ripple(at: target) }
            }
        }
        scheduleThinking()
        guard phase != .up, phase != .move || action == "move" else { return }
        let typing = action == "type" || action == "set_value"
        say("\(presence.name) · \(narration ?? Self.verb(action))", busy: typing, hold: 1.6)
    }

    /// Replays a menu command over the menu bar without opening the app's menu: the cursor
    /// visits the menu title, a light copy of the path drops below it and the command is
    /// picked. Purely visual and never waited on; the command has already run.
    func showMenu(titleFrame: CGRect?, path: [String], shortcut: String?) {
        guard let window, let root = window.contentView?.layer, !paused, let titleFrame, Geometry.valid(titleFrame), path.count > 1 else { return }
        let title = Self.cocoa(titleFrame).offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
        let rows = Array(path.dropFirst())
        let rowHeight: CGFloat = 22
        let labels = rows.enumerated().map { index, name in
            index == rows.count - 1 ? name + (shortcut.map { "    " + Self.glyphs($0) } ?? "") : name + "  ›"
        }
        let width = max(150, (labels.map { ceil(($0 as NSString).size(withAttributes: [.font: Self.font]).width) }.max() ?? 0) + 28)
        let height = CGFloat(rows.count) * rowHeight + 8
        let panel = CALayer()
        panel.frame = CGRect(x: title.minX, y: title.minY - height - 2, width: width, height: height)
        panel.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.94).cgColor
        panel.cornerRadius = 8; panel.borderWidth = 1; panel.borderColor = presence.color.withAlphaComponent(0.55).cgColor
        panel.shadowOpacity = 0.22; panel.shadowRadius = 10; panel.shadowOffset = CGSize(width: 0, height: -3)
        for (index, label) in labels.enumerated() {
            let y = height - 4 - CGFloat(index + 1) * rowHeight
            let picked = index == labels.count - 1
            if picked {
                let pick = CALayer()
                pick.frame = CGRect(x: 4, y: y, width: width - 8, height: rowHeight)
                pick.backgroundColor = presence.color.withAlphaComponent(0.9).cgColor; pick.cornerRadius = 5
                panel.addSublayer(pick)
            }
            let text = CATextLayer()
            text.string = label; text.font = Self.font; text.fontSize = Self.font.pointSize
            text.foregroundColor = (picked ? NSColor.white : NSColor.labelColor).cgColor
            text.contentsScale = window.backingScaleFactor
            text.frame = CGRect(x: 12, y: y + 3, width: width - 20, height: rowHeight - 6)
            panel.addSublayer(text)
        }
        let appear = CABasicAnimation(keyPath: "opacity"); appear.fromValue = 0; appear.toValue = 1; appear.duration = 0.12
        panel.add(appear, forKey: "appear")
        root.insertSublayer(panel, below: cursor)
        highlight(screenRect: titleFrame)
        let mark = motion
        let pickPoint = CGPoint(x: panel.frame.minX + 28, y: panel.frame.minY + 4 + rowHeight / 2)
        let travel = glide(to: CGPoint(x: title.midX, y: title.midY))
        DispatchQueue.main.asyncAfter(deadline: .now() + travel + 0.1) { [weak self] in
            guard let self, self.motion == mark, !self.paused else { return }
            let more = self.glide(to: pickPoint)
            DispatchQueue.main.asyncAfter(deadline: .now() + more) { [weak self] in
                guard let self, self.motion == mark else { return }
                self.ripple(at: pickPoint)
            }
        }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1; fade.toValue = 0; fade.beginTime = CACurrentMediaTime() + 0.75; fade.duration = 0.3
        fade.fillMode = .forwards; fade.isRemovedOnCompletion = false
        panel.add(fade, forKey: "fade")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { panel.removeFromSuperlayer() }
    }

    /// "command+shift+b" as the menu shows it: ⇧⌘B.
    nonisolated static func glyphs(_ chord: String) -> String {
        let parts = chord.split(separator: "+").map(String.init)
        let order: [(String, String)] = [("control", "⌃"), ("option", "⌥"), ("shift", "⇧"), ("command", "⌘")]
        let held = order.filter { parts.contains($0.0) }.map(\.1).joined()
        return held + (parts.last.map { $0.count == 1 ? $0.uppercased() : $0 } ?? "")
    }

    /// Briefly outline the accessible control that was pressed or filled.
    func highlight(screenRect rect: CGRect) {
        guard let window, let root = window.contentView?.layer, Geometry.valid(rect), !paused else { return }
        let local = Self.cocoa(rect).offsetBy(dx: -window.frame.minX, dy: -window.frame.minY).insetBy(dx: -4, dy: -4)
        let box = CAShapeLayer()
        box.path = CGPath(roundedRect: local, cornerWidth: 7, cornerHeight: 7, transform: nil)
        box.fillColor = presence.color.withAlphaComponent(0.14).cgColor
        box.strokeColor = presence.color.cgColor
        box.lineWidth = 2
        root.insertSublayer(box, below: cursor)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1; fade.toValue = 0; fade.beginTime = CACurrentMediaTime() + 0.5; fade.duration = 0.4
        fade.fillMode = .forwards; fade.isRemovedOnCompletion = false
        box.add(fade, forKey: "fade")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { box.removeFromSuperlayer() }
    }

    func end() {
        guard let window else { return }
        generation += 1
        let ending = generation
        tracker?.invalidate(); tracker = nil
        resetTag?.cancel(); resetTag = nil
        stopThinking()
        // Wave goodbye: control is back with the person.
        paused = false
        say("\(presence.name) · all yours", busy: false, hold: nil)
        badge?.orderOut(nil); badge = nil; pill = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.45
            window.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.generation == ending else { return }
                self.window?.orderOut(nil); self.window = nil
                self.cursorPoint = nil; self.windowFrame = .null; self.windowID = 0; self.narration = nil
            }
        })
    }

    private static func verb(_ action: String) -> String {
        switch action {
        case "click": return "clicking"
        case "double_click": return "double-clicking"
        case "triple_click": return "selecting"
        case "type", "set_value": return "typing"
        case "key": return "shortcut"
        case "scroll": return "scrolling"
        case "drag": return "dragging"
        case "press": return "pressing"
        case "menu": return "choosing a menu command"
        case "move": return "pointing"
        default: return "working"
        }
    }

    // MARK: Layers

    private func build() {
        let screen = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1, height: 1)
        let window = NSWindow(contentRect: screen, styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
        window.ignoresMouseEvents = true
        window.sharingType = .none
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        let view = NSView(frame: NSRect(origin: .zero, size: screen.size))
        view.wantsLayer = true
        view.autoresizingMask = [.width, .height]
        window.contentView = view
        guard let root = view.layer else { return }
        let color = presence.color

        outline.fillColor = nil
        outline.strokeColor = color.cgColor
        outline.lineWidth = 2.5
        outline.shadowColor = color.cgColor
        outline.shadowOpacity = 0.8; outline.shadowRadius = 12; outline.shadowOffset = .zero
        root.addSublayer(outline)

        trail.fillColor = nil
        trail.strokeColor = color.withAlphaComponent(0.55).cgColor
        trail.lineWidth = 3; trail.lineCap = .round; trail.lineJoin = .round
        trail.lineDashPattern = [1, 6]
        root.addSublayer(trail)

        // The cursor container's position is the arrow tip: the exact input point.
        cursor.bounds = .zero
        cursor.opacity = 0
        let path = CGMutablePath()
        path.move(to: .zero)
        for point in [(0.0, -19.0), (5.0, -14.5), (8.5, -22.0), (11.5, -20.6), (8.2, -13.4), (14.5, -13.4)] {
            path.addLine(to: CGPoint(x: point.0, y: point.1))
        }
        path.closeSubpath()
        arrow.path = path
        arrow.fillColor = color.cgColor
        arrow.strokeColor = NSColor.white.cgColor
        arrow.lineWidth = 1.6; arrow.lineJoin = .round
        arrow.shadowColor = NSColor.black.cgColor
        arrow.shadowOpacity = 0.35; arrow.shadowRadius = 3; arrow.shadowOffset = CGSize(width: 0, height: -1.5)
        cursor.addSublayer(arrow)

        let text = Self.readableText(on: color)
        tag.backgroundColor = color.cgColor
        tag.cornerRadius = 12
        tag.borderColor = NSColor.white.withAlphaComponent(0.9).cgColor
        tag.borderWidth = 1.2
        tag.shadowColor = NSColor.black.cgColor
        tag.shadowOpacity = 0.3; tag.shadowRadius = 4; tag.shadowOffset = CGSize(width: 0, height: -1.5)
        tag.anchorPoint = CGPoint(x: 0, y: 1)
        tag.position = CGPoint(x: 13, y: -19)
        tagText.font = Self.font; tagText.fontSize = 12
        tagText.foregroundColor = text.cgColor
        tagText.contentsScale = scale
        tagText.alignmentMode = .left
        // Swap words instantly; a crossfade overlaps the old and new text.
        tagText.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]
        tag.addSublayer(tagText)
        for index in 0..<3 {
            let dot = CALayer()
            dot.frame = CGRect(x: Double(index) * 6, y: 0, width: 4, height: 4)
            dot.cornerRadius = 2
            dot.backgroundColor = text.cgColor
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 0.25; pulse.toValue = 1; pulse.duration = 0.45
            pulse.autoreverses = true; pulse.repeatCount = .infinity
            pulse.beginTime = CACurrentMediaTime() + Double(index) * 0.15
            dot.add(pulse, forKey: "pulse")
            dots.addSublayer(dot)
        }
        dots.isHidden = true
        dots.actions = ["hidden": NSNull(), "bounds": NSNull(), "position": NSNull()]
        tag.addSublayer(dots)
        cursor.addSublayer(tag)
        root.addSublayer(cursor)
        self.window = window
        say(presence.name, busy: false, hold: nil)
    }

    static func readableText(on color: NSColor) -> NSColor {
        guard let rgb = color.usingColorSpace(.sRGB) else { return .white }
        let luminance = 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
        return luminance > 0.62 ? NSColor(white: 0.1, alpha: 1) : .white
    }

    private func say(_ text: String, busy: Bool, hold: TimeInterval?) {
        let lead: CGFloat = 10
        let textWidth = ceil((text as NSString).size(withAttributes: [.font: Self.font]).width)
        let width = lead + textWidth + 10 + (busy ? 22 : 0)
        CATransaction.begin(); CATransaction.setAnimationDuration(0.18)
        tag.bounds = CGRect(x: 0, y: 0, width: width, height: 24)
        CATransaction.setDisableActions(true)
        tagText.string = text
        tagText.frame = CGRect(x: lead, y: 4, width: textWidth + 2, height: 16)
        dots.isHidden = !busy
        dots.frame = CGRect(x: lead + textWidth + 6, y: 10, width: 16, height: 4)
        CATransaction.commit()
        resetTag?.cancel(); resetTag = nil
        guard let hold else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.paused, self.window != nil else { return }
            self.say(self.narration.map { "\(self.presence.name) · \($0)" } ?? self.presence.name, busy: false, hold: nil)
        }
        resetTag = work
        DispatchQueue.main.asyncAfter(deadline: .now() + hold, execute: work)
    }

    private func arrive(at point: CGPoint) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        cursor.position = point; cursor.opacity = 1
        CATransaction.commit()
        cursorPoint = point
        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.3; pop.toValue = 1
        pop.damping = 12; pop.stiffness = 220; pop.duration = pop.settlingDuration
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0; fade.toValue = 1; fade.duration = 0.2
        cursor.add(pop, forKey: "pop"); cursor.add(fade, forKey: "fade")
    }

    /// Moves the cursor and returns roughly how long until it arrives.
    @discardableResult private func glide(to target: CGPoint) -> TimeInterval {
        guard cursorPoint != nil else { arrive(at: target); return 0 }
        guard cursorPoint != target else { return 0 }
        // Start from where the cursor is on screen, so a new input mid-flight stays smooth.
        let from = cursor.presentation()?.position ?? cursor.position
        let spring = CASpringAnimation(keyPath: "position")
        spring.fromValue = NSValue(point: from); spring.toValue = NSValue(point: target)
        spring.mass = 1; spring.stiffness = 320; spring.damping = 32
        spring.duration = min(spring.settlingDuration, 0.5)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        cursor.position = target; cursor.opacity = 1
        CATransaction.commit()
        cursor.add(spring, forKey: "move")
        cursorPoint = target
        return min(0.2, spring.duration * 0.4)
    }

    /// Between inputs the model is deciding its next step: say so with a gentle wiggle.
    private func scheduleThinking() {
        idle?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.window != nil, !self.paused else { return }
            let wiggle = CAKeyframeAnimation(keyPath: "transform.rotation.z")
            wiggle.values = [0, 0.09, 0, -0.09, 0]; wiggle.duration = 1.4; wiggle.repeatCount = .infinity
            self.arrow.add(wiggle, forKey: "think")
            self.say("\(self.presence.name) · thinking", busy: true, hold: nil)
        }
        idle = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
    }

    private func stopThinking() {
        idle?.cancel(); idle = nil
        arrow.removeAnimation(forKey: "think")
    }

    private func ripple(at point: CGPoint) {
        guard let root = window?.contentView?.layer else { return }
        let ring = CAShapeLayer()
        ring.path = CGPath(ellipseIn: CGRect(x: -16, y: -16, width: 32, height: 32), transform: nil)
        ring.position = point
        ring.fillColor = presence.color.withAlphaComponent(0.18).cgColor
        ring.strokeColor = presence.color.cgColor
        ring.lineWidth = 2
        ring.opacity = 0
        root.insertSublayer(ring, below: cursor)
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.3; grow.toValue = 1.6
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9; fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]; group.duration = 0.5
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ring.add(group, forKey: "ripple")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { ring.removeFromSuperlayer() }
    }

    private func drawTrail(fading: Bool) {
        let path = CGMutablePath()
        if let first = trailPoints.first { path.move(to: first); trailPoints.dropFirst().forEach { path.addLine(to: $0) } }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        trail.removeAnimation(forKey: "fade")
        trail.path = path; trail.opacity = 1
        CATransaction.commit()
        guard fading else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1; fade.toValue = 0; fade.duration = 0.6
        fade.fillMode = .forwards; fade.isRemovedOnCompletion = false
        trail.add(fade, forKey: "fade")
        trailPoints = []
    }

    // MARK: Window tracking

    private func order() {
        guard let window else { return }
        window.level = layered ? .normal : .statusBar
        if layered { window.order(.above, relativeTo: Int(windowID)) } else { window.orderFrontRegardless() }
    }

    /// Follows the window when the person moves it, and hides with it.
    private func track() {
        guard window != nil, windowID != 0 else { return }
        // Windows the person raises go above presence; keep it right above the selected one.
        if layered { order() }
        let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first
        let onScreen = info?[kCGWindowIsOnscreen as String] as? Bool ?? false
        let bounds = (info?[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        window?.alphaValue = onScreen ? 1 : 0
        if hidden == onScreen { hidden = !onScreen; refreshPill() }
        if onScreen, let bounds, Geometry.valid(windowFrame), bounds != windowFrame {
            let dx = bounds.minX - windowFrame.minX, dy = windowFrame.minY - bounds.minY
            let screen = window?.frame
            place(bounds)
            // Carry the cursor along with the window instead of leaving it behind.
            if let point = cursorPoint, window?.frame == screen {
                let moved = CGPoint(x: point.x + dx, y: point.y + dy)
                CATransaction.begin(); CATransaction.setDisableActions(true)
                cursor.position = moved
                CATransaction.commit()
                cursorPoint = moved
            }
        }
    }

    private func place(_ frame: CGRect) {
        guard let window, Geometry.valid(frame) else { return }
        let target = Self.cocoa(frame)
        let screen = NSScreen.screens.max { lhs, rhs in
            let a = lhs.frame.intersection(target), b = rhs.frame.intersection(target)
            return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
        }
        // Displays usually have separate Spaces, so one window cannot span them.
        if let screen, window.frame != screen.frame {
            window.setFrame(screen.frame, display: false)
            cursorPoint = nil
        }
        windowFrame = frame
        let rect = target.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY).insetBy(dx: -3, dy: -3)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        outline.path = CGPath(roundedRect: rect, cornerWidth: 12, cornerHeight: 12, transform: nil)
        CATransaction.commit()
        positionPill()
    }

    // MARK: Window pill

    private func refreshPill() {
        if badge == nil { buildPill() }
        let status = paused ? "You have control · \(presence.name) is waiting" : "\(presence.name) is \(narration ?? "working") in \(appName)"
        // A hidden window keeps a visible pill, so the person can still see the work and stop it.
        let label = paused ? "Your turn" : hidden ? "\(presence.name) · \(appName)" : presence.name
        pill?.update(name: label, status: status, paused: paused)
        positionPill()
        badge?.orderFrontRegardless()
    }

    private func buildPill() {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 80, height: 26), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
        panel.sharingType = .none
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.acceptsMouseMovedEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        let view = PresencePill(color: presence.color)
        view.onClick = { [weak self] sender in self?.showMenu(from: sender) }
        view.onResize = { [weak self] in self?.positionPill() }
        panel.contentView = view
        badge = panel; pill = view
    }

    private func showMenu(from view: NSView) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let header = NSMenuItem(title: paused ? "You have control · \(presence.name) is waiting" : "\(presence.name) is working in \(appName)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())
        func item(_ title: String, _ symbol: String, _ action: Selector) {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
            entry.target = self
            entry.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            menu.addItem(entry)
        }
        if !paused { item("Take over", "hand.raised", #selector(takeOverTapped)) }
        else if canContinue { item("Continue", "play", #selector(continueTapped)) }
        item("Stop", "stop.circle", #selector(stopTapped))
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: view)
    }

    private func positionPill() {
        guard let badge, let pill, Geometry.valid(windowFrame) else { return }
        let size = pill.preferredSize
        let rect = Self.cocoa(windowFrame)
        if hidden, let screen = NSScreen.screens.first(where: { $0.frame.intersects(rect) }) ?? NSScreen.main {
            let top = screen.visibleFrame
            badge.setFrame(NSRect(x: top.maxX - size.width - 12, y: top.maxY - size.height - 10, width: size.width, height: size.height), display: true)
            return
        }
        // Cover the traffic-light buttons at the window's top-left corner.
        badge.setFrame(NSRect(x: rect.minX + 6, y: rect.maxY - 6 - size.height, width: size.width, height: size.height), display: true)
    }

    @objc private func takeOverTapped() { onTakeOver?() }
    @objc private func continueTapped() { onContinue?() }
    @objc private func stopTapped() { onStop?() }
}

/// The pill over the selected window's buttons: a dot in the agent's color, its
/// name and a "controlling this window" glyph; hovering widens it to say what
/// the agent is doing.
@MainActor
private final class PresencePill: NSView {
    var onClick: ((NSView) -> Void)?
    var onResize: (() -> Void)?
    private let color: NSColor
    private let dot = CALayer()
    private let label = NSTextField(labelWithString: "")
    private let glyph = NSImageView()
    private var name = ""
    private var status = ""
    private var hovering = false

    init(color: NSColor) {
        self.color = color
        super.init(frame: NSRect(x: 0, y: 0, width: 80, height: 26))
        wantsLayer = true
        layer?.cornerRadius = 13
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.white.withAlphaComponent(0.6).cgColor
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.lineBreakMode = .byTruncatingTail
        glyph.symbolConfiguration = .init(pointSize: 11, weight: .semibold)
        // The agent's color stays visible on the orange "Your turn" fill too.
        dot.backgroundColor = color.cgColor
        dot.cornerRadius = 5
        dot.borderWidth = 1.5
        dot.borderColor = NSColor.white.cgColor
        dot.actions = ["position": NSNull(), "bounds": NSNull()]
        layer?.addSublayer(dot)
        for view in [label, glyph] as [NSView] { addSubview(view) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError() }

    var preferredSize: NSSize {
        let text = (label.stringValue as NSString).size(withAttributes: [.font: label.font ?? NSFont.systemFont(ofSize: 12)]).width
        return NSSize(width: max(80, ceil(text) + 28 + 28), height: 26)
    }

    func update(name: String, status: String, paused: Bool) {
        self.name = name; self.status = status
        let fill = paused ? NSColor.systemOrange : color
        let ink = AgentCursor.readableText(on: fill)
        layer?.backgroundColor = fill.cgColor
        label.textColor = ink
        glyph.contentTintColor = ink
        glyph.image = NSImage(systemSymbolName: paused ? "hand.raised.fill" : "rectangle.inset.filled.and.person.filled", accessibilityDescription: nil)
            ?? NSImage(systemSymbolName: "display", accessibilityDescription: nil)
        toolTip = status
        setAccessibilityLabel("\(status). Show computer controls")
        relabel()
    }

    private func relabel() {
        label.stringValue = hovering ? status : name
        let size = preferredSize
        setFrameSize(size)
        dot.frame = CGRect(x: 9, y: 8, width: 10, height: 10)
        let textX: CGFloat = 25
        label.frame = NSRect(x: textX, y: 5, width: size.width - textX - 24, height: 16)
        glyph.frame = NSRect(x: size.width - 21, y: 5, width: 15, height: 16)
        onResize?()
    }

    func nudge() {
        let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
        pulse.values = [1, 1.12, 1, 1.06, 1]; pulse.duration = 0.6
        layer?.add(pulse, forKey: "nudge")
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        layer?.borderColor = NSColor.white.cgColor
        relabel()
    }
    override func mouseExited(with event: NSEvent) {
        hovering = false
        layer?.borderColor = NSColor.white.withAlphaComponent(0.6).cgColor
        relabel()
    }
    override func mouseDown(with event: NSEvent) { onClick?(self) }
    override func accessibilityPerformPress() -> Bool { onClick?(self); return true }
}
