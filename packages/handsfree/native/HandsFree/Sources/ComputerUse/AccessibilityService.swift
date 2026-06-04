import AppKit
import ApplicationServices
import ScreenCaptureKit

final class AccessibilityService: @unchecked Sendable {
    private let screenshotImageWidth: CGFloat = 768
    private let maxElements = 250
    private let maxDepth = 22

    private let importantRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
        "AXComboBox", "AXTextField", "AXTextArea", "AXSearchField", "AXLink",
        "AXSlider", "AXIncrementor", "AXScrollArea", "AXScrollBar", "AXTabGroup",
        "AXTab", "AXMenuItem", "AXCell", "AXRow", "AXStaticText", "AXImage",
        "AXOutline", "AXTable", "AXList", "AXGroup",
    ]

    func resolveTarget(appName: String?) throws -> WindowTarget {
        try resolveTarget(appName: appName, windowTitle: nil)
    }

    func resolveTarget(appName: String?, windowTitle: String?) throws -> WindowTarget {
        guard AXIsProcessTrusted() else { throw ComputerUseError.accessibilityDenied }

        let app = try resolveApp(appName: appName)
        let pid = app.processIdentifier
        let axApp = AXUIElementCreateApplication(pid)
        let axWindow = firstAXWindow(axApp: axApp, title: windowTitle)
        let title = axWindow.flatMap { axString($0, kAXTitleAttribute) }
        let info = firstCGWindowInfo(pid: pid, title: title)
        let bounds = axWindow.flatMap(axFrame) ?? info?.bounds

        guard let bounds, bounds.width > 20, bounds.height > 20 else {
            throw ComputerUseError.noWindow(app.localizedName ?? appName ?? "frontmost app")
        }

        return WindowTarget(
            appName: app.localizedName ?? "Unknown",
            pid: pid,
            windowNumber: info?.number,
            windowTitle: title ?? info?.title,
            bounds: bounds,
            isFrontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
            axWindow: axWindow
        )
    }

    func snapshot(target: WindowTarget, strictMode: Bool, backgroundActivated: Bool) async throws -> AppSnapshot {
        let records = records(target: target)
        let (data, meta) = try await captureScreenshot(target: target)

        return AppSnapshot(
            id: "",
            observation: 0,
            appName: target.appName,
            pid: target.pid,
            windowNumber: target.windowNumber,
            windowTitle: target.windowTitle,
            screenshotData: data,
            screenshotMimeType: "image/jpeg",
            screenshotMeta: meta,
            records: records,
            strictMode: strictMode,
            backgroundActivated: backgroundActivated,
            recentActions: [],
            addedLabels: [],
            removedLabels: []
        )
    }

    func records(target: WindowTarget) -> [AXElementRecord] {
        target.axWindow.map(semanticRecords(window:)) ?? []
    }

    func press(record: AXElementRecord) -> Bool {
        AXUIElementPerformAction(record.element, kAXPressAction as CFString) == .success
    }

    func focus(record: AXElementRecord) -> Bool {
        AXUIElementSetAttributeValue(record.element, kAXFocusedAttribute as CFString, true as CFBoolean) == .success
    }

    func setValue(record: AXElementRecord, value: String) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(record.element, kAXValueAttribute as CFString, &settable) == .success,
              settable.boolValue else {
            return false
        }
        return AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, value as CFString) == .success
    }

    func performAction(record: AXElementRecord, action: String) -> Bool {
        AXUIElementPerformAction(record.element, action as CFString) == .success
    }

    private func resolveApp(appName: String?) throws -> NSRunningApplication {
        guard let rawName = appName?.trimmingCharacters(in: .whitespacesAndNewlines), !rawName.isEmpty else {
            guard let frontmost = NSWorkspace.shared.frontmostApplication else {
                throw ComputerUseError.noFrontmostApplication
            }
            return frontmost
        }

        let needle = rawName.lowercased()
        let regularApps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        if let exact = regularApps.first(where: { $0.localizedName?.lowercased() == needle }) {
            return exact
        }
        if let contains = regularApps.first(where: { $0.localizedName?.lowercased().contains(needle) == true }) {
            return contains
        }
        throw ComputerUseError.appNotFound(rawName)
    }

    private func firstAXWindow(axApp: AXUIElement, title preferredTitle: String?) -> AXUIElement? {
        var windowValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowValue) == .success,
              let windows = windowValue as? [AXUIElement] else {
            return nil
        }
        let usable = windows.filter { window in
            guard let frame = axFrame(window) else { return false }
            return frame.width > 20 && frame.height > 20
        }
        if let preferredTitle, let match = usable.first(where: { axString($0, kAXTitleAttribute) == preferredTitle }) {
            return match
        }
        return usable.first
    }

    private func semanticRecords(window: AXUIElement) -> [AXElementRecord] {
        var records: [AXElementRecord] = []
        collect(element: window, depth: 0, records: &records)
        return records
    }

    private func collect(element: AXUIElement, depth: Int, records: inout [AXElementRecord]) {
        guard depth <= maxDepth, records.count < maxElements else { return }

        let rawRole = axString(element, kAXRoleAttribute) ?? "AXUnknown"
        let role = normalizedRole(rawRole)
        let value = axString(element, kAXValueAttribute).map { String($0.prefix(120)) }
        let label = semanticLabel(element: element, role: role, value: value)
        let actions = axActions(element)
        let frame = axFrame(element)
        let capabilities = capabilitiesFor(element: element, rawRole: rawRole, actions: actions)
        let shouldSurface = shouldSurfaceElement(rawRole: rawRole, label: label, value: value, frame: frame, capabilities: capabilities)

        if shouldSurface, let frame {
            let id = records.count + 1
            let semantic = SemanticAXElement(
                id: id,
                ref: "{e\(id)}",
                role: role,
                label: label,
                value: value,
                frame: ElementFrame(
                    x: Int(frame.origin.x),
                    y: Int(frame.origin.y),
                    width: Int(frame.width),
                    height: Int(frame.height)
                ),
                state: stateFor(element: element, rawRole: rawRole),
                capabilities: capabilities
            )
            records.append(AXElementRecord(element: element, semantic: semantic))
        }

        for child in axChildren(element) {
            collect(element: child, depth: depth + 1, records: &records)
            if records.count >= maxElements { break }
        }
    }

    private func shouldSurfaceElement(rawRole: String, label: String, value: String?, frame: CGRect?, capabilities: AXElementCapabilities) -> Bool {
        guard let frame, frame.width > 1, frame.height > 1 else { return false }
        let hasSemanticText = !label.isEmpty || value?.isEmpty == false
        let interactive = capabilities.canPress || capabilities.canFocus || capabilities.canScroll || capabilities.canAdjust || capabilities.canSetValue
        if interactive { return true }
        if !importantRoles.contains(rawRole) { return false }
        if rawRole == "AXGroup" { return hasSemanticText && frame.width < 900 && frame.height < 700 }
        return hasSemanticText
    }

    private func semanticLabel(element: AXUIElement, role: String, value: String?) -> String {
        let candidates = [
            axString(element, kAXTitleAttribute),
            axString(element, kAXDescriptionAttribute),
            axString(element, kAXHelpAttribute),
            axString(element, kAXIdentifierAttribute),
            value,
        ]
        for candidate in candidates {
            if let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
                return String(trimmed.prefix(120))
            }
        }
        return role
    }

    private func capabilitiesFor(element: AXUIElement, rawRole: String, actions: [String]) -> AXElementCapabilities {
        var valueSettable = DarwinBoolean(false)
        let canSetValue = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable) == .success && valueSettable.boolValue

        var focusSettable = DarwinBoolean(false)
        let canFocus = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusSettable) == .success && focusSettable.boolValue

        let canAdjust = actions.contains(kAXIncrementAction) || actions.contains(kAXDecrementAction) || rawRole == "AXSlider" || rawRole == "AXIncrementor"
        let canScroll = actions.contains("AXScrollToVisible") || rawRole == "AXScrollArea" || rawRole == "AXScrollBar"
        let canPress = actions.contains(kAXPressAction) || ["AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem", "AXPopUpButton", "AXMenuButton", "AXCell"].contains(rawRole)

        return AXElementCapabilities(
            canPress: canPress,
            canFocus: canFocus,
            canScroll: canScroll,
            canAdjust: canAdjust,
            canSetValue: canSetValue,
            actions: actions
        )
    }

    private func stateFor(element: AXUIElement, rawRole: String) -> AXElementState {
        AXElementState(
            enabled: axBool(element, kAXEnabledAttribute),
            focused: axBool(element, kAXFocusedAttribute),
            selected: axBool(element, kAXSelectedAttribute),
            expanded: axBool(element, kAXExpandedAttribute),
            checked: rawRole == "AXCheckBox" || rawRole == "AXRadioButton" ? axBool(element, kAXValueAttribute) : nil
        )
    }

    private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let children = value as? [AXUIElement] else {
            return []
        }
        return children
    }

    private func axActions(_ element: AXUIElement) -> [String] {
        var actionNames: CFArray?
        guard AXUIElementCopyActionNames(element, &actionNames) == .success,
              let names = actionNames as? [String] else {
            return []
        }
        return names
    }

    private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value else {
            return nil
        }
        if let string = value as? String, !string.isEmpty { return string }
        if let attributed = value as? NSAttributedString, !attributed.string.isEmpty { return attributed.string }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    private func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value else {
            return nil
        }
        if let bool = value as? Bool { return bool }
        if let number = value as? NSNumber { return number.boolValue }
        return nil
    }

    private func axFrame(_ element: AXUIElement) -> CGRect? {
        guard let position = axPoint(element, kAXPositionAttribute), let size = axSize(element, kAXSizeAttribute) else {
            return nil
        }
        return CGRect(origin: position, size: size)
    }

    private func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value,
              CFGetTypeID(value) == AXValueGetTypeID() else {
            return nil
        }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cgPoint else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
        return point
    }

    private func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value,
              CFGetTypeID(value) == AXValueGetTypeID() else {
            return nil
        }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cgSize else { return nil }
        var size = CGSize.zero
        guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
        return size
    }

    private func normalizedRole(_ rawRole: String) -> String {
        rawRole.hasPrefix("AX") ? String(rawRole.dropFirst(2)) : rawRole
    }

    private func firstCGWindowInfo(pid: pid_t, title: String?) -> (number: Int, title: String?, bounds: CGRect)? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        let candidates = list.compactMap { info -> (number: Int, title: String?, bounds: CGRect)? in
            guard let ownerPID = info[kCGWindowOwnerPID as String] as? Int32,
                  ownerPID == pid,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  layer == 0,
                  let number = info[kCGWindowNumber as String] as? Int,
                  let boundsDict = info[kCGWindowBounds as String] as? [String: Any] else {
                return nil
            }
            let bounds = CGRect(
                x: cgFloat(boundsDict["X"]),
                y: cgFloat(boundsDict["Y"]),
                width: cgFloat(boundsDict["Width"]),
                height: cgFloat(boundsDict["Height"])
            )
            guard bounds.width > 20, bounds.height > 20 else { return nil }
            return (number, info[kCGWindowName as String] as? String, bounds)
        }

        if let title, let exact = candidates.first(where: { $0.title == title }) {
            return exact
        }
        return candidates.first
    }

    private func captureScreenshot(target: WindowTarget) async throws -> (Data, ScreenshotMetadata) {
        let cgImage = await screenCaptureKitImage(target: target) ?? legacyCaptureImage(target: target)
        guard let cgImage else { throw ComputerUseError.screenshotFailed }

        return try encodeScreenshot(cgImage, capturedBounds: target.bounds)
    }

    private func legacyCaptureImage(target: WindowTarget) -> CGImage? {
        if let windowNumber = target.windowNumber {
            return CGWindowListCreateImage(
                CGRect.null,
                .optionIncludingWindow,
                CGWindowID(windowNumber),
                [.bestResolution, .boundsIgnoreFraming]
            )
        }

        return CGWindowListCreateImage(target.bounds, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
    }

    private func screenCaptureKitImage(target: WindowTarget) async -> CGImage? {
        guard let windowNumber = target.windowNumber else { return nil }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: { Int($0.windowID) == windowNumber }) else { return nil }
            let configuration = SCStreamConfiguration()
            let scale = screenScale(for: target.bounds)
            configuration.width = max(1, Int(target.bounds.width * scale))
            configuration.height = max(1, Int(target.bounds.height * scale))
            configuration.showsCursor = false
            let filter = SCContentFilter(desktopIndependentWindow: window)
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            return nil
        }
    }

    private func screenScale(for bounds: CGRect) -> CGFloat {
        NSScreen.screens.first(where: { $0.frame.intersects(bounds) })?.backingScaleFactor
            ?? NSScreen.main?.backingScaleFactor
            ?? 2
    }

    private func encodeScreenshot(_ cgImage: CGImage, capturedBounds: CGRect) throws -> (Data, ScreenshotMetadata) {
        let rawWidth = CGFloat(cgImage.width)
        let rawHeight = CGFloat(cgImage.height)
        let targetWidth = min(screenshotImageWidth, rawWidth)
        let targetHeight = rawHeight * (targetWidth / rawWidth)

        let source = NSImage(cgImage: cgImage, size: NSSize(width: rawWidth, height: rawHeight))
        let resized = NSImage(size: NSSize(width: targetWidth, height: targetHeight))
        resized.lockFocus()
        source.draw(in: NSRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        resized.unlockFocus()

        guard let tiff = resized.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.45]) else {
            throw ComputerUseError.screenshotFailed
        }

        return (
            jpeg,
            ScreenshotMetadata(
                imageWidth: Int(targetWidth),
                imageHeight: Int(targetHeight),
                capturedBounds: capturedBounds
            )
        )
    }

    private func cgFloat(_ value: Any?) -> CGFloat {
        if let value = value as? CGFloat { return value }
        if let value = value as? Double { return CGFloat(value) }
        if let value = value as? Int { return CGFloat(value) }
        if let value = value as? NSNumber { return CGFloat(truncating: value) }
        return 0
    }
}
