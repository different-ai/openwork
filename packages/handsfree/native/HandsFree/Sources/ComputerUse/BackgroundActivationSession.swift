import AppKit
import CoreGraphics

final class BackgroundActivationSession: @unchecked Sendable {
    private final class TapContext {
        let suppressFocusMessages: Bool

        init(suppressFocusMessages: Bool) {
            self.suppressFocusMessages = suppressFocusMessages
        }
    }

    private struct TapRef {
        let tap: CFMachPort
        let source: CFRunLoopSource
        let context: TapContext
    }

    private let previousPID: pid_t
    private let targetPID: pid_t
    private var taps: [TapRef] = []
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private var startupError: Error?
    private var started = false
    private var lastTarget: WindowTarget?

    init(previousPID: pid_t, targetPID: pid_t) {
        self.previousPID = previousPID
        self.targetPID = targetPID
    }

    deinit {
        stop()
    }

    func start() throws {
        guard !started else { return }

        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [weak self] in
            guard let self else {
                ready.signal()
                return
            }
            self.runLoop = CFRunLoopGetCurrent()
            do {
                try self.installTapsOnCurrentRunLoop()
            } catch {
                self.startupError = error
            }
            ready.signal()
            if self.startupError == nil {
                CFRunLoopRun()
            }
        }
        thread.name = "OpenWorkBackgroundActivationSession"
        self.thread = thread
        thread.start()
        ready.wait()

        if let startupError {
            throw startupError
        }
        started = true
    }

    func activate(target: WindowTarget) async throws {
        guard let windowNumber = target.windowNumber else {
            throw ComputerUseError.strictModeViolation("target window has no CG window number")
        }

        postAppKitDefined(subtype: 1, target: target, windowNumber: windowNumber)
        try await Task.sleep(nanoseconds: 25_000_000)
        try await BackgroundInputDispatcher.click(pid: target.pid, windowNumber: windowNumber, point: target.center)
        try await Task.sleep(nanoseconds: 80_000_000)
        lastTarget = target
    }

    func stop() {
        if let target = lastTarget, let windowNumber = target.windowNumber {
            postAppKitDefined(subtype: 2, target: target, windowNumber: windowNumber)
        }
        for tapRef in taps {
            CFMachPortInvalidate(tapRef.tap)
        }
        taps.removeAll()
        if let runLoop {
            CFRunLoopStop(runLoop)
        }
        runLoop = nil
        thread = nil
        started = false
    }

    private func installTapsOnCurrentRunLoop() throws {
        if previousPID != targetPID {
            taps.append(try installTap(pid: previousPID, suppressFocusMessages: true))
        }
        taps.append(try installTap(pid: targetPID, suppressFocusMessages: false))
    }

    private func installTap(pid: pid_t, suppressFocusMessages: Bool) throws -> TapRef {
        let context = TapContext(suppressFocusMessages: suppressFocusMessages)
        let userInfo = Unmanaged.passUnretained(context).toOpaque()
        guard let tap = CGEvent.tapCreateForPid(
            pid: pid,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask.max,
            callback: BackgroundActivationSession.eventTapCallback,
            userInfo: userInfo
        ) else {
            throw ComputerUseError.strictModeViolation("could not install per-process event tap for pid \(pid)")
        }

        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            throw ComputerUseError.strictModeViolation("could not create run loop source for pid \(pid) event tap")
        }

        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return TapRef(tap: tap, source: source, context: context)
    }

    private func postAppKitDefined(subtype: Int16, target: WindowTarget, windowNumber: Int) {
        guard let event = NSEvent.otherEvent(
            with: .appKitDefined,
            location: target.center,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: windowNumber,
            context: nil,
            subtype: subtype,
            data1: 0,
            data2: 0
        )?.cgEvent else {
            return
        }

        BackgroundInputDispatcher.address(event, pid: target.pid, windowNumber: windowNumber)
        event.postToPid(target.pid)
    }

    private static let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            return Unmanaged.passUnretained(event)
        }
        guard let userInfo else {
            return Unmanaged.passUnretained(event)
        }
        let context = Unmanaged<TapContext>.fromOpaque(userInfo).takeUnretainedValue()
        if context.suppressFocusMessages && BackgroundActivationSession.isFocusMessage(type) {
            return nil
        }
        return Unmanaged.passUnretained(event)
    }

    private static func isFocusMessage(_ type: CGEventType) -> Bool {
        let raw = Int(type.rawValue)
        return raw == 13 || raw == 19 || raw == 20
    }
}
