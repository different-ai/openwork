import AppKit
import Foundation

final class FrontmostApplicationMonitor: @unchecked Sendable {
    private let queue = DispatchQueue(label: "openwork.computer-use.frontmost-monitor")
    private var timer: DispatchSourceTimer?
    private var lastPID: pid_t?

    init(onChange: @escaping @Sendable (pid_t?) -> Void) {
        lastPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
            if pid != self.lastPID {
                self.lastPID = pid
                onChange(pid)
            }
        }
        timer = source
        source.resume()
    }

    deinit {
        timer?.cancel()
    }
}
