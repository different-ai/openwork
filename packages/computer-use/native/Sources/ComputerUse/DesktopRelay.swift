import Foundation
import Darwin

// An unprivileged stdio-to-socket adapter. The desktop broker filters the MCP
// channel; approval/resume commands never traverse this agent-facing connection.
func runDesktopRelay(_ path: String) {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { exit(1) }
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { exit(1) }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 else { fputs("Open OpenWork, then reconnect Computer Use.\n", stderr); exit(1) }
    signal(SIGPIPE, SIG_IGN)
    DispatchQueue.global().async {
        while true {
            let data = FileHandle.standardInput.availableData
            if data.isEmpty { shutdown(fd, SHUT_WR); return }
            let sent = data.withUnsafeBytes { buffer -> Bool in
                var offset = 0
                while offset < buffer.count {
                    let n = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if n <= 0 { return false }; offset += n
                }
                return true
            }
            if !sent { return }
        }
    }
    let reader = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    while true { let data = reader.availableData; if data.isEmpty { break }; FileHandle.standardOutput.write(data) }
}
