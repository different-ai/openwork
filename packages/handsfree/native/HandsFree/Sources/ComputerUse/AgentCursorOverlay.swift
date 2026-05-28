import AppKit

final class AgentCursorOverlay: @unchecked Sendable {
    static let shared = AgentCursorOverlay()

    private var panel: AgentCursorPanel?
    private var hideWorkItem: DispatchWorkItem?
    private let size = CGSize(width: 30, height: 34)

    func show(at point: CGPoint) {
        DispatchQueue.main.async { [weak self] in
            self?.showOnMain(at: point)
        }
    }

    private func showOnMain(at point: CGPoint) {
        let panel = ensurePanel()
        panel.setFrame(frame(for: point), display: true)
        panel.orderFrontRegardless()

        hideWorkItem?.cancel()
        let nextHide = DispatchWorkItem { [weak panel] in
            panel?.orderOut(nil)
        }
        hideWorkItem = nextHide
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: nextHide)
    }

    private func ensurePanel() -> AgentCursorPanel {
        if let panel { return panel }

        let panel = AgentCursorPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.contentView = AgentCursorView(frame: NSRect(origin: .zero, size: size))
        self.panel = panel
        return panel
    }

    private func frame(for topLeftPoint: CGPoint) -> NSRect {
        let screen = screenContaining(topLeftPoint) ?? NSScreen.main
        let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = screenFrame.minX + topLeftPoint.x - 2
        let y = screenFrame.maxY - topLeftPoint.y - size.height + 2
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    private func screenContaining(_ topLeftPoint: CGPoint) -> NSScreen? {
        NSScreen.screens.first { screen in
            let frame = screen.frame
            return topLeftPoint.x >= frame.minX
                && topLeftPoint.x <= frame.maxX
                && topLeftPoint.y >= 0
                && topLeftPoint.y <= frame.height
        }
    }
}

final class AgentCursorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class AgentCursorView: NSView {
    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let shadow = NSShadow()
        shadow.shadowBlurRadius = 3
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
        shadow.set()

        let path = NSBezierPath()
        path.move(to: NSPoint(x: 4, y: 30))
        path.line(to: NSPoint(x: 4, y: 4))
        path.line(to: NSPoint(x: 12, y: 11))
        path.line(to: NSPoint(x: 17, y: 1))
        path.line(to: NSPoint(x: 22, y: 4))
        path.line(to: NSPoint(x: 17, y: 14))
        path.line(to: NSPoint(x: 27, y: 14))
        path.close()

        NSColor.white.setFill()
        path.fill()

        shadow.shadowColor = .clear
        shadow.set()
        NSColor.systemBlue.setStroke()
        path.lineWidth = 2
        path.stroke()
    }
}
