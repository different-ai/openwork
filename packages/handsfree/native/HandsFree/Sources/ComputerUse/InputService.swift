import Foundation
import CoreGraphics

final class InputService: @unchecked Sendable {
    func moveMouse(point: CGPoint) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }
        guard let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
            throw ComputerUseError.eventCreationFailed
        }
        event.post(tap: .cghidEventTap)
    }

    func click(point: CGPoint, doubleClick: Bool = false) async throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }

        if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            move.post(tap: .cghidEventTap)
        }
        try await Task.sleep(nanoseconds: 50_000_000)

        let count = doubleClick ? 2 : 1
        for clickState in 1...count {
            guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw ComputerUseError.eventCreationFailed
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    func typeText(_ text: String) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }
        let units = Array(text.utf16)
        for start in stride(from: 0, to: units.count, by: 20) {
            let end = min(start + 20, units.count)
            let chunk = Array(units[start..<end])
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) else {
                throw ComputerUseError.eventCreationFailed
            }
            event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            event.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.01)
        }
    }

    func pressKey(_ combo: String) throws {
        let parsed = try BackgroundInputDispatcher.parseCombo(combo)
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: parsed.keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: parsed.keyCode, keyDown: false) else {
            throw ComputerUseError.eventCreationFailed
        }
        down.flags = parsed.flags
        up.flags = parsed.flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    func scroll(point: CGPoint?, deltaX: Int32, deltaY: Int32) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else {
            throw ComputerUseError.eventCreationFailed
        }
        if let point { event.location = point }
        event.post(tap: .cgSessionEventTap)
    }

    func drag(path: [CGPoint]) async throws {
        guard path.count >= 2 else { return }
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }
        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: path[0], mouseButton: .left) else {
            throw ComputerUseError.eventCreationFailed
        }
        down.post(tap: .cghidEventTap)
        for point in path.dropFirst().dropLast() {
            if let drag = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) {
                drag.post(tap: .cghidEventTap)
            }
            try await Task.sleep(nanoseconds: 12_000_000)
        }
        guard let last = path.last,
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: last, mouseButton: .left) else {
            throw ComputerUseError.eventCreationFailed
        }
        up.post(tap: .cghidEventTap)
    }
}
