import Darwin
import Foundation

/// macOS grants Accessibility and Screen Recording to the *responsible*
/// process, which for a plain child is the app that started it. Started by
/// OpenWork, a Screen Recording grant would only apply once OpenWork itself
/// quit. The helper therefore relaunches itself once with responsibility
/// disclaimed: System Settings lists "OpenWork Computer Use", and only this
/// short-lived helper ever has to restart after a grant.
///
/// The first process stays as a thin parent: it keeps the host's trust check,
/// shares stdin/stdout/stderr with the relaunched helper, forwards signals and
/// exits with its status. The relaunched helper exits if that parent goes away.
enum Responsibility {
    private static let relaunchedKey = "OPENWORK_COMPUTER_USE_DISCLAIMED"
    private static let hostKey = "OPENWORK_COMPUTER_USE_HOST_PID"
    private static var parentWatch: DispatchSourceProcess?
    private static var helperPID: pid_t = 0

    /// The desktop that launched the helper, across the relaunch.
    static let hostPID: pid_t = {
        if let value = ProcessInfo.processInfo.environment[hostKey], let pid = pid_t(value), pid > 1 { return pid }
        return getppid()
    }()

    /// Returns in the process that should do the work: the relaunched helper,
    /// or this one when macOS offers no way to disclaim responsibility.
    static func relaunchDisclaimed(requireTrustedHost: Bool) {
        if ProcessInfo.processInfo.environment[relaunchedKey] == "1" {
            _ = hostPID
            unsetenv(relaunchedKey); unsetenv(hostKey)
            exitWithParent()
            return
        }
        // The relaunched helper's parent is this same-team process, so the
        // desktop's identity is checked here, before anything is started.
        if requireTrustedHost && !HostTrust.embeddedHostIsTrusted() {
            fputs("Computer control requires the helper and desktop host to be signed by the same Apple team.\n", stderr)
            exit(1)
        }
        typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
              let executable = Bundle.main.executablePath else { return }
        let setDisclaim = unsafeBitCast(symbol, to: SetDisclaim.self)

        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { return }
        defer { posix_spawnattr_destroy(&attributes) }
        guard setDisclaim(&attributes, 1) == 0 else { return }

        var environment = ProcessInfo.processInfo.environment
        environment[relaunchedKey] = "1"
        environment[hostKey] = String(getppid())
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { envp.forEach { free($0) } }

        // Forwarded signals must reach the helper, so hold them until it exists.
        let forwarded = [SIGTERM, SIGINT, SIGHUP]
        for signalNumber in forwarded {
            signal(signalNumber) { received in
                if Responsibility.helperPID > 0 { kill(Responsibility.helperPID, received) }
            }
        }
        var pid: pid_t = 0
        guard posix_spawn(&pid, executable, nil, &attributes, CommandLine.unsafeArgv, envp) == 0 else {
            for signalNumber in forwarded { signal(signalNumber, SIG_DFL) }
            return
        }
        helperPID = pid
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        let signaled = status & 0x7f
        exit(signaled == 0 ? (status >> 8) & 0xff : 128 + signaled)
    }

    /// A SIGKILLed parent cannot forward anything: end like a stopped helper.
    private static func exitWithParent() {
        let parent = getppid()
        guard parent > 1 else { raise(SIGTERM); return }
        let watch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .global())
        watch.setEventHandler { raise(SIGTERM) }
        watch.resume()
        parentWatch = watch
        if getppid() != parent { raise(SIGTERM) }
    }
}
