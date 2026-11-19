import XCTest
import ApplicationServices
@testable import ComputerUse

/// Window scans over synthetic trees shaped like large web pages.
@MainActor
final class DeepTreeScanTests: XCTestCase {
    /// A synthetic accessibility tree. Each node is an application element for an
    /// unused pid, which gives distinct, comparable `AXUIElement`s without any app.
    final class Tree {
        struct Node {
            var role: String
            var subrole: String? = nil
            var label = ""
            var frame = CGRect(x: 0, y: 0, width: 1000, height: 1000)
            var children: [Int] = []
        }
        private(set) var nodes: [Node] = []
        private static let base: pid_t = 600_000

        init() { nodes.append(Node(role: "AXWindow", label: "Window")) }
        var window: AXUIElement { element(0) }
        func element(_ id: Int) -> AXUIElement { AXUIElementCreateApplication(Self.base + pid_t(id)) }
        func id(_ element: AXUIElement) -> Int {
            var pid: pid_t = 0
            _ = AXUIElementGetPid(element, &pid)
            return Int(pid - Self.base)
        }
        @discardableResult func add(_ node: Node, under parent: Int) -> Int {
            nodes.append(node)
            nodes[parent].children.append(nodes.count - 1)
            return nodes.count - 1
        }
        /// A chain of unnamed groups `levels` deep under `parent`; returns the innermost.
        func chain(_ levels: Int, under parent: Int) -> Int {
            var last = parent
            for _ in 0..<levels { last = add(Node(role: "AXGroup"), under: last) }
            return last
        }
        func depth(of id: Int) -> Int {
            var depth = 0, current = id
            while current != 0, let parent = nodes.firstIndex(where: { $0.children.contains(current) }) { depth += 1; current = parent }
            return depth
        }
        var reader: AXTreeReader {
            AXTreeReader(
                role: { self.nodes[self.id($0)].role },
                subrole: { self.nodes[self.id($0)].subrole },
                isProtected: { element, _, _ in self.nodes[self.id(element)].subrole == "AXSecureTextField" },
                isSecureTextField: { element, role in
                    ElementRecord.textRoles.contains(role) && self.nodes[self.id(element)].subrole == "AXSecureTextField"
                },
                frame: { self.nodes[self.id($0)].frame },
                text: { element, name in name == kAXTitleAttribute ? self.nodes[self.id(element)].label : nil },
                flag: { _, _ in nil },
                actions: { ["AXButton", "AXLink"].contains(self.nodes[self.id($0)].role) ? [kAXPressAction] : [] },
                settable: { ElementRecord.textRoles.contains(self.nodes[self.id($0)].role) },
                children: { element, limit, _ in
                    let children = self.nodes[self.id(element)].children
                    return AXChildrenSnapshot(parent: element, total: children.count,
                        elements: children.prefix(max(0, limit)).map(self.element))
                },
                focused: { _ in nil },
                checkBudget: {})
        }
        func scan() async throws -> WindowState { try await AXTreeScan.run(window, reader: reader) }
    }

    private func button(_ label: String, y: Double = 10) -> Tree.Node {
        Tree.Node(role: "AXButton", label: label, frame: CGRect(x: 10, y: y, width: 80, height: 20))
    }

    func testAPageFortyFiveLevelsDeepIsListedAndCaptured() async throws {
        let tree = Tree()
        let page = tree.chain(45, under: 0)
        tree.add(button("Save app"), under: page)
        XCTAssertGreaterThan(tree.depth(of: page), 24, "deeper than the old limit")
        let state = try await tree.scan()
        XCTAssertNil(state.privacyIssue)
        XCTAssertTrue(state.records.contains { $0.label == "Save app" })
        XCTAssertNoThrow(try state.requireCapture())
    }

    func testAThousandsOfElementsPageIsScannedInFull() async throws {
        let tree = Tree()
        let page = tree.chain(30, under: 0)
        for row in 0..<60 {
            let group = tree.chain(5, under: page)
            for cell in 0..<50 { tree.add(Tree.Node(role: "AXStaticText", label: "r\(row)c\(cell)", frame: CGRect(x: 0, y: 0, width: 40, height: 10)), under: group) }
        }
        XCTAssertGreaterThan(tree.nodes.count, 3_000)
        let state = try await tree.scan()
        XCTAssertNil(state.privacyIssue)
        XCTAssertEqual(state.visited, tree.nodes.count)
        XCTAssertTrue(state.listCapped, "the listing still stops at its cap")
        XCTAssertEqual(state.records.count, AXTreeScan.listLimit)
        XCTAssertNoThrow(try state.requireCapture())
    }

    func testAPasswordFieldBelowTheOldDepthLimitIsMasked() async throws {
        let tree = Tree()
        let form = tree.chain(40, under: 0)
        let frame = CGRect(x: 100, y: 200, width: 200, height: 24)
        tree.add(Tree.Node(role: "AXTextField", subrole: "AXSecureTextField", label: "Password", frame: frame), under: form)
        let state = try await tree.scan()
        XCTAssertNil(state.privacyIssue)
        XCTAssertEqual(state.protectedFrames, [frame])
        let field = try XCTUnwrap(state.records.first { $0.protected })
        XCTAssertEqual(field.label, ElementRecord.secureLabel)
        XCTAssertNil(field.value)
        XCTAssertNoThrow(try state.requireCapture())
    }

    func testABranchPastTheDepthLimitWithholdsTheImageButTheRestIsListed() async throws {
        let tree = Tree()
        tree.add(button("Top"), under: 0)
        let tooDeep = tree.chain(AXTreeScan.maxDepth + 4, under: 0)
        tree.add(Tree.Node(role: "AXTextField", subrole: "AXSecureTextField", frame: CGRect(x: 0, y: 0, width: 100, height: 20)), under: tooDeep)
        tree.add(button("After", y: 50), under: 0)
        let state = try await tree.scan()
        XCTAssertEqual(state.privacyIssue, "tree_limit")
        XCTAssertTrue(state.protectedFrames.isEmpty, "the unread password field has no mask")
        XCTAssertThrowsError(try state.requireCapture()) { XCTAssertEqual(($0 as? UseError)?.code, "privacy_incomplete") }
        XCTAssertTrue(Set(state.records.map(\.label)).isSuperset(of: ["Top", "After"]), "controls outside the skipped branch are still listed")
    }

    func testTooManyElementsStillWithholdsTheImage() async throws {
        let tree = Tree()
        let page = tree.chain(3, under: 0)
        for index in 0..<(AXTreeScan.maxElements + 10) {
            tree.add(Tree.Node(role: "AXStaticText", label: "\(index)", frame: CGRect(x: 0, y: 0, width: 10, height: 10)), under: page)
        }
        let state = try await tree.scan()
        XCTAssertEqual(state.privacyIssue, "tree_limit")
        XCTAssertThrowsError(try state.requireCapture())
    }

    func testADialogAppendedAfterALargePageIsListed() async throws {
        let tree = Tree()
        let web = tree.chain(12, under: 0)
        for index in 0..<400 { tree.add(button("Row \(index)", y: 10 + Double(index % 40) * 20), under: web) }
        let dialog = tree.add(Tree.Node(role: "AXGroup", subrole: "AXApplicationDialog", label: "Submit for review",
            frame: CGRect(x: 300, y: 300, width: 400, height: 200)), under: web)
        let body = tree.chain(4, under: dialog)
        tree.add(button("Confirm", y: 450), under: body)
        let state = try await tree.scan()
        XCTAssertNil(state.privacyIssue)
        XCTAssertTrue(state.listCapped)
        let labels = state.records.map(\.label)
        XCTAssertTrue(labels.contains("Confirm"), "the dialog is listed before the page fills the listing")
        XCTAssertLessThan(try XCTUnwrap(labels.firstIndex(of: "Confirm")), try XCTUnwrap(labels.firstIndex(of: "Row 0")))
    }

    func testDialogsComeFirstAndOtherwiseKeepTheAppOrder() {
        XCTAssertEqual(AXTreeScan.ordered(["a", "sheet", "b", "dialog"]) { ["sheet", "dialog"].contains($0) }, ["sheet", "dialog", "a", "b"])
        XCTAssertTrue(AXTreeScan.isDialog(role: "AXSheet", subrole: nil))
        XCTAssertTrue(AXTreeScan.isDialog(role: "AXGroup", subrole: "AXApplicationDialog"))
        XCTAssertTrue(AXTreeScan.isDialog(role: "AXGroup", subrole: "AXApplicationAlertDialog"))
        XCTAssertFalse(AXTreeScan.isDialog(role: "AXGroup", subrole: "AXDocument"))
        XCTAssertFalse(AXTreeScan.readsSubroleAhead(role: "AXTextField"), "text inputs read their subrole strictly when visited")
    }
}
