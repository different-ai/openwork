import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDocument, DomUtils } from "htmlparser2"
import { buildGmailDraftRaw } from "../src/capability-sources/gmail.ts"
import { escapeHtmlAttribute } from "../src/capability-sources/gmail-draft-body.ts"

function parts(body: string, extra: Partial<Parameters<typeof buildGmailDraftRaw>[0]> = {}): { plain: string; html: string } {
  const mime = Buffer.from(buildGmailDraftRaw({ to: "recipient@example.com", subject: "Draft", body, ...extra }), "base64url").toString("utf8")
  function part(type: string): string {
    const match = mime.match(new RegExp(`Content-Type: text/${type};[^\\r]+\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`))
    assert.ok(match)
    return Buffer.from(match[1], "base64").toString("utf8")
  }
  return { plain: part("plain"), html: part("html") }
}

for (const [name, body, plain, html] of [
  ["bold", "**bold** and __strong__", "bold and strong", "<strong>bold</strong> and <strong>strong</strong>"],
  ["italic", "*italic* and _emphasis_ with snake_case", "italic and emphasis with snake_case", "<em>italic</em> and <em>emphasis</em> with snake_case"],
  ["nested inline", "**bold *italic* text**", "bold italic text", "<strong>bold <em>italic</em> text</strong>"],
  ["code", "Use `**literal** <tag>`", "Use **literal** <tag>", "<code>**literal** &lt;tag&gt;</code>"],
  ["link", "[a **guide**](https://example.com/guide?a=1&b=2)", "a guide (https://example.com/guide?a=1&b=2)", '<a href="https://example.com/guide?a=1&amp;b=2">a <strong>guide</strong></a>'],
  ["mailto", "[contact](mailto:team@example.com)", "contact (mailto:team@example.com)", '<a href="mailto:team@example.com">contact</a>'],
  ["bare URL", "Visit https://example.com/path.", "Visit https://example.com/path.", '<a href="https://example.com/path">https://example.com/path</a>.'],
  ["http and URL parentheses", "[guide](http://example.com/a_(b))", "guide (http://example.com/a_(b))", '<a href="http://example.com/a_(b)">guide</a>'],
  ["image stays literal", "![image](https://example.com/image.png)", "![image](https://example.com/image.png)", "![image](https://example.com/image.png)"],
  ["escaped markdown", "\\*literal\\*", "*literal*", "*literal*"],
  ["heading", "# Update", "Update", "<strong>Update</strong>"],
  ["raw HTML", '<img src=x onerror="alert(1)"><script>alert(2)</script>', '<img src=x onerror="alert(1)"><script>alert(2)</script>', '&lt;img src=x onerror="alert(1)"&gt;&lt;script&gt;alert(2)&lt;/script&gt;'],
]) {
  test(`draft renders ${name} safely in HTML with a readable plain alternative`, () => {
    const result = parts(body)
    assert.equal(result.plain, plain)
    assert.ok(result.html.includes(html), result.html)
    assert.ok(!result.html.includes("<script"))
    assert.ok(!result.html.includes("<img"))
  })
}

for (const url of ["javascript:alert(1)", "data:text/html,payload", "file:///private/file", "//example.com/path", "ftp://example.com", "https://example.com/\"onclick=\"alert", "https://example.com/\u0000bad"]) {
  test(`draft never emits an active link for disallowed or malformed URL ${JSON.stringify(url)}`, () => {
    const { html, plain } = parts(`[label](${url})`)
    assert.ok(!html.includes("<a "), html)
    assert.ok(plain.includes("label"))
  })
}

test("draft renders a closing and sender name separated by one real newline as two lines", () => {
  const body = "Thanks,\nGuillaume"
  const result = parts(body)
  assert.equal(result.plain, body)
  const lines = DomUtils.findAll(element => element.name === "div", parseDocument(result.html).children)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(element => DomUtils.textContent(element)), ["Thanks,", "Guillaume"])
  assert.ok(lines.every(element => element.attribs.dir === "ltr"))
})

test("draft keeps blank lines, line breaks, indentation, tabs and repeated spaces", () => {
  const body = "Hello\nsecond line\n\n  indented    columns\n\ttabbed\n\n"
  const result = parts(body)
  assert.equal(result.plain, body)
  assert.ok(result.html.includes('dir="ltr"'))
  assert.ok(result.html.includes("white-space:pre-wrap"))
  assert.ok(result.html.includes("  indented    columns"))
  assert.ok(result.html.includes("\ttabbed"))
  assert.equal((result.html.match(/<div><br><\/div>/g) ?? []).length, 3)
})

test("draft renders unordered, ordered and simply nested lists without literal inline markers", () => {
  const result = parts("- **First**\n  - *Nested*\n    1. `Deep`\n- Second\n\n1. Review\n2. Approve")
  assert.ok(result.html.includes("<ul"))
  assert.ok(result.html.includes("<ol"))
  assert.equal((result.html.match(/<li[ >]/g) ?? []).length, 6)
  assert.ok(result.html.includes("<strong>First</strong>"))
  assert.ok(!result.html.includes("**First**"))
  assert.equal(result.plain, "- First\n  - Nested\n    1. Deep\n- Second\n\n1. Review\n2. Approve")
})

test("draft renders authored block quotes, preserving separate lines and nesting", () => {
  const result = parts("> **First**\n> second\n>\n>> nested")
  assert.equal((result.html.match(/<blockquote[ >]/g) ?? []).length, 2)
  assert.ok(result.html.includes("<strong>First</strong>"))
  assert.ok(!result.html.includes("&gt;"))
  assert.equal(result.plain, "> First\n> second\n> \n> > nested")
})

test("draft renders pipe tables with inline borders and aligned plain text", () => {
  const result = parts("| Area | Status |\n| :--- | ---: |\n| Body | **Ready** |\n| [Guide](https://example.com) | `Safe` |")
  assert.ok(result.html.includes("<table"))
  assert.equal((result.html.match(/<th[ >]/g) ?? []).length, 2)
  assert.equal((result.html.match(/<td[ >]/g) ?? []).length, 4)
  assert.ok(result.html.includes("border:1px solid #dadce0"))
  assert.ok(result.html.includes("text-align:right"))
  assert.ok(!result.html.includes("<style"))
  const rows = result.plain.split("\n")
  assert.equal(rows.length, 4)
  assert.ok(rows[3].includes("Guide (https://example.com)"))
  assert.equal(new Set(rows.map(row => row.lastIndexOf("|"))).size, 1)
})

test("draft supports star bullets, ordered starts and tab-indented nesting", () => {
  const result = parts("* First\n\t* Nested\n\n3. Third\n4. Fourth")
  assert.ok(result.html.includes('<ol start="3"'))
  assert.equal((result.html.match(/<ul[ >]/g) ?? []).length, 2)
  assert.equal(result.plain, "* First\n\t* Nested\n\n3. Third\n4. Fourth")
})

test("draft aligns short table cells without amplifying oversized sparse tables", () => {
  const short = parts("| A | B |\n| --- | --- |\n| x | y |")
  assert.equal(new Set(short.plain.split("\n").map(row => row.length)).size, 1)
  const longCell = "x".repeat(4_000)
  const body = `| ${longCell} | B |\n| --- | --- |\n` + "| x | y |\n".repeat(300)
  const result = parts(body)
  assert.ok(result.plain.includes(longCell))
  assert.ok(result.plain.length < 100_000)
  assert.equal((result.html.match(/<td[ >]/g) ?? []).length, 600)
})

test("draft keeps escaped pipes and code pipes inside table cells", () => {
  const result = parts("| Label | Value |\n| --- | --- |\n| a\\|b | `x|y` |")
  assert.equal((result.html.match(/<td[ >]/g) ?? []).length, 2)
  assert.ok(result.html.includes("a|b"))
  assert.ok(result.html.includes("<code>x|y</code>"))
})

test("draft leaves malformed table syntax as escaped lines", () => {
  const body = "| Label | Value |\n| not a delimiter | row |\n| <tag> | data |"
  const result = parts(body)
  assert.equal(result.plain, body)
  assert.ok(!result.html.includes("<table"))
  assert.ok(result.html.includes("&lt;tag&gt;"))
})

test("draft fenced code preserves literal markup, blank lines and wrap-width lines", () => {
  const code = "**literal** <script>\n\nThis paragraph is deliberately wrapped near seventy-two characters so that\nthe draft builder can restore flowing prose without merging signatures or\nother blocks whose line breaks carry meaning.\n  keep    spaces"
  for (const fence of ["```", "~~~~"]) {
    const result = parts(`${fence}text\n${code}\n${fence}`)
    assert.equal(result.plain, code)
    assert.ok(result.html.includes("<pre"))
    assert.ok(result.html.includes("**literal** &lt;script&gt;"))
    assert.ok(!result.html.includes("<strong"))
    assert.ok(!result.html.includes("<script"))
  }
})

test("draft safely handles unclosed fences and unmatched markers", () => {
  assert.equal(parts("```\n**literal**").plain, "**literal**")
  const body = "Unmatched **bold and [link and `code"
  assert.equal(parts(body).plain, body)
})

test("draft input cannot inject elements, attributes, styles or unsafe link schemes", () => {
  const payloads = [
    '<svg/onload=alert(1)><iframe src="https://example.com"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '[click](javascript&#58;alert(1))',
    '[click](jav\\tascript:alert(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '[click](https://example.com/&quot;onclick=&quot;alert(1))',
    '**<style>body{display:none}</style>**',
    '> <img src=x onerror=alert(1)>',
    '| x | y |\n| --- | --- |\n| <script> | [x](file:///private) |',
  ]
  const tags = new Set(["div", "br", "strong", "em", "code", "a", "pre", "ul", "ol", "li", "blockquote", "table", "tr", "th", "td"])
  for (const payload of payloads) {
    const elements = DomUtils.findAll(() => true, parseDocument(parts(payload).html).children)
    for (const element of elements) {
      assert.ok(tags.has(element.name), element.name)
      assert.ok(Object.keys(element.attribs).every(name => ["style", "dir", "href", "start"].includes(name)))
      if (element.attribs.href) assert.ok(["http:", "https:", "mailto:"].includes(new URL(element.attribs.href).protocol))
      if (element.attribs.style) assert.ok(!/url\(|expression|display|position/i.test(element.attribs.style))
    }
  }
})

test("attribute encoding escapes all five HTML attribute metacharacters", () => {
  assert.equal(escapeHtmlAttribute('&\"\'<>'), "&amp;&quot;&#39;&lt;&gt;")
  for (const payload of ['\" onmouseover=\"alert(1)', "' onmouseover='alert(1)"]) {
    for (const [attribute, value] of [["href", `https://example.com/?q=${payload}&x=<tag>`], ["style", `white-space:pre-wrap;${payload}`]]) {
      const encoded = escapeHtmlAttribute(value)
      assert.ok(!/[\"'<>]/.test(encoded), encoded)
      const elements = DomUtils.findAll(() => true, parseDocument(`<div ${attribute}="${encoded}">content</div>`).children)
      assert.equal(elements.length, 1)
      assert.deepEqual(Object.keys(elements[0].attribs), [attribute])
      assert.equal(elements[0].attribs[attribute], value)
    }
  }
})

for (const payload of ['\" onmouseover=\"alert(1)', "' onmouseover='alert(1)"]) {
  test(`draft cannot promote quote payload ${JSON.stringify(payload)} from text or URLs to attributes`, () => {
    for (const body of [
      `[${payload}](https://example.com/?a=1&b=2)`,
      `[label](https://example.com/${payload})`,
      `https://example.com/${payload}`,
      `**${payload}**`,
      `- ${payload}\n  - nested ${payload}`,
      `3. ${payload}`,
      `> ${payload}`,
      `~~~${payload}\n${payload}\n~~~`,
      `| Label | Value |\n| --- | ---: |\n| ${payload} | ${payload} |`,
      `| Label | Value |\n| --- | ---:${payload} |\n| text | text |`,
    ]) {
      const result = parts(body)
      const elements = DomUtils.findAll(() => true, parseDocument(result.html).children)
      assert.ok(elements.length > 0)
      assert.ok(elements.every(element => !Object.keys(element.attribs).some(name => /^on/i.test(name))))
      for (const element of elements) {
        if (element.attribs.href) {
          assert.ok(["http:", "https:", "mailto:"].includes(new URL(element.attribs.href).protocol))
          assert.ok(!/[\"'<>\s]/.test(element.attribs.href))
        }
        if (element.attribs.style) {
          assert.ok(!element.attribs.style.includes("onmouseover"))
          assert.ok(!/[\"'<>]/.test(element.attribs.style))
        }
        if (element.attribs.start) assert.equal(element.attribs.start, "3")
      }
      assert.ok(DomUtils.textContent(parseDocument(result.html)).includes(payload))
    }
    assert.ok(!parts(`[label](https://example.com/${payload})`).html.includes("<a "))
  })
}

test("draft handles maximum-size unmatched backticks and bounded quote nesting", { timeout: 2_000 }, () => {
  const body = "Literal " + "`".repeat(49_992)
  assert.equal(parts(body).plain, body)
  const nested = parts(">".repeat(1_000) + " text")
  assert.ok((nested.html.match(/<blockquote[ >]/g) ?? []).length <= 16)
  assert.ok(nested.plain.endsWith("text"))
})

test("draft preserves reply quote text and attachments independently of body markdown", () => {
  const quote = { attribution: "On a previous date, someone wrote:", body: "**history is literal**\n> older text" }
  for (const attachments of [[], [{ filename: "note.txt", mimeType: "text/plain", content: Buffer.from("attachment") }]]) {
    const result = parts("**New body**", { quote, attachments })
    assert.ok(result.plain.startsWith("New body\n\n"))
    assert.ok(result.html.startsWith('<div dir="ltr"'))
    assert.ok(result.html.includes("<strong>New body</strong>"))
    assert.ok(result.html.includes("<div>**history is literal**</div><div>&gt; older text</div>"))
    assert.ok(result.plain.includes("> **history is literal**\n> > older text"))
  }
})
