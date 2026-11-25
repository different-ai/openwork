import Foundation

/// One block of an answer. The screens draw each kind natively; nothing is rendered as a web page.
public enum MarkdownBlock: Sendable, Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullet(text: String, depth: Int)
    case numbered(marker: String, text: String, depth: Int)
    case quote(String)
    case code(String)
    case rule
}

public enum Markdown {
    /// Splits an answer into blocks. Anything it does not recognize stays a paragraph, so no text is lost.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var code: [String]?

        func endParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph = []
        }

        for raw in source.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(open.joined(separator: "\n")))
                    code = nil
                } else {
                    endParagraph()
                    code = []
                }
                continue
            }
            if code != nil {
                code?.append(line)
                continue
            }
            if trimmed.isEmpty {
                endParagraph()
                continue
            }
            let depth = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) } / 2
            if let heading = heading(trimmed) {
                endParagraph()
                blocks.append(heading)
            } else if trimmed.count >= 3, Set(trimmed).count == 1, let mark = trimmed.first, "-*_".contains(mark) {
                endParagraph()
                blocks.append(.rule)
            } else if let text = strip(trimmed, anyOf: ["- ", "* ", "+ "]) {
                endParagraph()
                blocks.append(.bullet(text: text, depth: depth))
            } else if let (marker, text) = numbered(trimmed) {
                endParagraph()
                blocks.append(.numbered(marker: marker, text: text, depth: depth))
            } else if let text = strip(trimmed, anyOf: ["> ", ">"]) {
                endParagraph()
                blocks.append(.quote(text))
            } else {
                paragraph.append(trimmed)
            }
        }
        // An answer still streaming can stop inside a code block: show what there is.
        if let open = code {
            blocks.append(.code(open.joined(separator: "\n")))
        }
        endParagraph()
        return blocks
    }

    /// Inline styling (bold, italic, code, links) for one block. Only web and mail links stay tappable.
    public static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard var styled = try? AttributedString(markdown: text, options: options) else { return AttributedString(text) }
        for run in styled.runs {
            guard let link = run.link, !isSafe(link) else { continue }
            styled[run.range].link = nil
        }
        return styled
    }

    /// Links an answer may open: web pages and mail, nothing that runs code or reaches into the phone.
    public static func isSafe(_ link: URL) -> Bool {
        ["http", "https", "mailto"].contains(link.scheme?.lowercased() ?? "")
    }

    private static func heading(_ line: String) -> MarkdownBlock? {
        let level = line.prefix { $0 == "#" }.count
        guard (1 ... 6).contains(level), line.dropFirst(level).first == " " else { return nil }
        return .heading(level: level, text: line.dropFirst(level).trimmingCharacters(in: .whitespaces))
    }

    private static func strip(_ line: String, anyOf prefixes: [String]) -> String? {
        for prefix in prefixes where line.hasPrefix(prefix) {
            return String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private static func numbered(_ line: String) -> (String, String)? {
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard let mark = rest.first, mark == "." || mark == ")", rest.dropFirst().first == " " else { return nil }
        return ("\(digits).", rest.dropFirst(2).trimmingCharacters(in: .whitespaces))
    }
}
