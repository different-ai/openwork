import Foundation
import CoreGraphics

enum BackgroundInputDispatcher {
    private static let privateWindowField = CGEventField(rawValue: 51)
    private static let privateRouteField = CGEventField(rawValue: 58)

    static func click(pid: pid_t, windowNumber: Int, point: CGPoint, doubleClick: Bool = false) async throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }

        let clickCount = doubleClick ? 2 : 1
        for clickState in 1...clickCount {
            guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw ComputerUseError.eventCreationFailed
            }

            address(down, pid: pid, windowNumber: windowNumber)
            down.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
            down.setDoubleValueField(.mouseEventPressure, value: 1)
            down.postToPid(pid)

            try await Task.sleep(nanoseconds: 30_000_000)

            address(up, pid: pid, windowNumber: windowNumber)
            up.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
            up.setDoubleValueField(.mouseEventPressure, value: 0)
            up.postToPid(pid)

            if clickState < clickCount {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
    }

    static func scroll(pid: pid_t, windowNumber: Int, point: CGPoint, deltaX: Int32, deltaY: Int32) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else {
            throw ComputerUseError.eventCreationFailed
        }
        event.location = point
        address(event, pid: pid, windowNumber: windowNumber)
        event.postToPid(pid)
    }

    static func typeText(pid: pid_t, text: String) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }

        let units = Array(text.utf16)
        let chunkSize = 20
        for start in stride(from: 0, to: units.count, by: chunkSize) {
            let end = min(start + chunkSize, units.count)
            let chunk = Array(units[start..<end])
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) else {
                throw ComputerUseError.eventCreationFailed
            }
            event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
            event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            event.postToPid(pid)
            Thread.sleep(forTimeInterval: 0.01)
        }
    }

    static func pressKey(pid: pid_t, combo: String) throws {
        let parsed = try parseCombo(combo)
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.eventSourceFailed
        }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: parsed.keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: parsed.keyCode, keyDown: false) else {
            throw ComputerUseError.eventCreationFailed
        }

        down.flags = parsed.flags
        up.flags = parsed.flags
        down.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        up.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        down.postToPid(pid)
        up.postToPid(pid)
    }

    static func address(_ event: CGEvent, pid: pid_t, windowNumber: Int) {
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowNumber))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowNumber))
        if let privateWindowField {
            event.setIntegerValueField(privateWindowField, value: Int64(windowNumber))
        }
        if let privateRouteField {
            event.setIntegerValueField(privateRouteField, value: 1)
        }
    }

    static func parseCombo(_ combo: String) throws -> (flags: CGEventFlags, keyCode: CGKeyCode) {
        let parts = combo.lowercased().split(separator: "+").map(String.init)
        var flags: CGEventFlags = []
        var keyName = ""

        for part in parts {
            switch part {
            case "command", "cmd", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "control", "ctrl": flags.insert(.maskControl)
            case "option", "alt": flags.insert(.maskAlternate)
            default: keyName = part
            }
        }

        guard let keyCode = keyCodes[keyName] else {
            throw ComputerUseError.unknownKey(keyName)
        }
        return (flags, keyCode)
    }

    private static let keyCodes: [String: CGKeyCode] = [
        "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31,
        "delete": 0x33, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
        "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
        "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
        "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E,
        "f": 0x03, "g": 0x05, "h": 0x04, "i": 0x22, "j": 0x26,
        "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D, "o": 0x1F,
        "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11,
        "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10, "z": 0x06,
        "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
        "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
        "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
        "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
        "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
        "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E,
        "\\": 0x2A, ";": 0x29, "'": 0x27, ",": 0x2B,
        ".": 0x2F, "/": 0x2C, "`": 0x32,
    ]
}
