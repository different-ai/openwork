import Foundation
import Darwin

// Embedded video must not block the main actor (including emergency Stop) on
// a slow host. Reliable messages stay ordered; frames are admitted only at idle.
@MainActor
final class MCPOutput {
    static let shared = MCPOutput()
    private let fileDescriptor: Int32
    private var nonblocking = false
    private var pending: [Data] = []
    private var current: Data?
    private var offset = 0
    private var currentIsFrame = false
    private var source: DispatchSourceWrite?
    private var failed = false
    var canSendFrame: Bool { nonblocking && !failed && current == nil && pending.isEmpty }

    init(fileDescriptor: Int32 = STDOUT_FILENO) { self.fileDescriptor = fileDescriptor }

    func enableNonblocking() {
        let flags = fcntl(fileDescriptor, F_GETFL)
        guard flags >= 0, fcntl(fileDescriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { exit(1) }
        signal(SIGPIPE, SIG_IGN)
        nonblocking = true
    }

    func send(_ value: [String: Any], frame: Bool = false) {
        guard !failed, !frame || canSendFrame,
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        let line = data + Data([10])
        guard nonblocking else { FileHandle.standardOutput.write(line); return }
        if current == nil && pending.isEmpty { current = line; currentIsFrame = frame } else { pending.append(line) }
        flush()
    }

    func discardUnsentFrame() {
        // Once any bytes reached the pipe, finish that JSON line before the
        // pause/closed state. Never truncate a record or reorder terminal state.
        guard currentIsFrame, offset == 0 else { return }
        current = nil; currentIsFrame = false
        flush()
    }

    private func flush() {
        if current == nil, !pending.isEmpty { current = pending.removeFirst(); currentIsFrame = false }
        guard let data = current else { source?.cancel(); source = nil; return }
        // Bound work per run-loop turn, even when a large PNG fits in the pipe.
        let count = data.withUnsafeBytes { bytes in
            Darwin.write(fileDescriptor, bytes.baseAddress!.advanced(by: offset), min(65_536, data.count - offset))
        }
        if count > 0 {
            offset += count
            if offset == data.count { current = nil; offset = 0; currentIsFrame = false }
        } else if count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
            failed = true; current = nil; pending.removeAll()
            SessionControls.active?.hostDisconnected()
        }
        if failed || (current == nil && pending.isEmpty) { source?.cancel(); source = nil; return }
        if source == nil {
            let writable = DispatchSource.makeWriteSource(fileDescriptor: fileDescriptor, queue: .main)
            writable.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.flush() } }
            source = writable; writable.resume()
        }
    }
}
