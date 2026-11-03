import assert from "node:assert/strict"
import { test } from "node:test"
import { buildGmailDraftRaw } from "../src/capability-sources/gmail.js"
import { buildGmailQuote, extractGmailThreadQuoteInput, extractGmailThreadReplyContext, gmailBodyHasQuotedHistory } from "../src/capability-sources/google-workspace-api.js"

import { from, date, part, message } from "./gmail-quote-fixture.js"
const quoteInput = (parts?: ReturnType<typeof part>[]) => {
  const input = extractGmailThreadQuoteInput({ messages: [message(parts)] })
  assert.ok(input)
  return input
}
function mimePart(raw: string, type: string): string {
  const mime = Buffer.from(raw, "base64url").toString("utf8")
  const encoded = mime.split(`Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n`)[1]?.split("\r\n--")[0]
  assert.ok(encoded)
  return Buffer.from(encoded, "base64").toString("utf8")
}
const render = (input: Parameters<typeof buildGmailQuote>[0]) => {
  const raw = buildGmailDraftRaw({ to: "recipient@example.test", subject: "Re: Synthetic conversation", body: "Thanks for the update.", quote: buildGmailQuote(input) })
  return { html: mimePart(raw, "text/html"), plain: mimePart(raw, "text/plain") }
}

test("HTML quotes retain nested history, links and tables while plain MIME retains original text", () => {
  const result = render(quoteInput())
  assert.match(result.html, /class="gmail_quote gmail_quote_container"/)
  assert.match(result.html, /<blockquote[^>]*>.*<blockquote[^>]*>.*<blockquote/s)
  assert.match(result.html, /<a href="https:\/\/example.test\/notes">Project notes<\/a>/)
  assert.match(result.html, /<table><tr><td>Milestone<\/td>/)
  assert.doesNotMatch(result.html, /&gt; Earlier|&gt; &gt;/)
  assert.match(result.plain, /> > Earlier reply\n> > > Original question/)
})

test("unsafe HTML is stripped without losing safe inline layout or CID images", () => {
  const original = '<html><head><style>body{display:none}</style><title>Hidden</title></head><body><script>alert(1)</script><div onclick="bad()" style="color:red;position:fixed;background-image:url(https://example.test/track)"><a href="jav&#x61;script:alert(1)">Bad link</a><a href="https://example.test">Safe link</a><img src="cid:diagram@example.test" alt="Diagram" onerror="bad()"><iframe src="https://example.test">Frame</iframe><svg onload="bad()"></svg></div></body></html>'
  const result = render(quoteInput([part("text/html", original)]))
  assert.doesNotMatch(result.html, /<script|<style|<head|<body|<html|<iframe|<svg|onclick|onerror|onload|javascript:|position:|background-image|Hidden|alert\(1\)/i)
  assert.match(result.html, /style="color:red"/)
  assert.match(result.html, /href="https:\/\/example.test"/)
  assert.match(result.html, /<img src="cid:diagram@example.test" alt="Diagram"/)
})

test("quoted remote and other non-CID images are dropped without affecting links or text", () => {
  for (const src of ["https://example.test/tracker.png", "http://example.test/tracker.png", "//example.test/tracker.png", "/tracker.png", "tracker.png", "mailto:tracker@example.test"]) {
    const result = render(quoteInput([part("text/html", `<div>Keep this text<img src="${src}" alt="Tracking"><a href="https://example.test/notes">Notes</a></div>`)]))
    assert.doesNotMatch(result.html, /<img|tracker|Tracking/)
    assert.match(result.html, /Keep this text/)
    assert.match(result.html, /href="https:\/\/example.test\/notes"/)
  }
})

test("quoted attached inline images keep their CID source and safe attributes", () => {
  const result = render(quoteInput([part("text/html", '<div>Diagram<img src="cid:diagram@example.test" alt="Attached diagram" width="120" height="80"></div>')]))
  assert.match(result.html, /<img src="cid:diagram@example.test" alt="Attached diagram" width="120" height="80"/)
})

test("quoted image srcset is removed even when the fallback source is CID", () => {
  const result = render(quoteInput([part("text/html", '<div>Diagram<img src="cid:diagram@example.test" srcset="https://example.test/tracker.png 1x, https://example.test/tracker2.png 2x"><img srcset="https://example.test/only-srcset.png 1x"></div>')]))
  assert.match(result.html, /src="cid:diagram@example.test"/)
  assert.equal(result.html.match(/<img/g)?.length, 1)
  assert.doesNotMatch(result.html, /srcset|tracker|only-srcset/)
})

test("quoted data images are removed rather than embedded", () => {
  const result = render(quoteInput([part("text/html", '<div>Keep this text<img src="data:image/png;base64,aGVsbG8=" alt="Embedded"></div>')]))
  assert.match(result.html, /Keep this text/)
  assert.doesNotMatch(result.html, /<img|data:image|aGVsbG8=|Embedded/)
})

test("quoted CSS and legacy background image URLs cannot survive the layout allowlist", () => {
  const result = render(quoteInput([part("text/html", '<div style="color:red;background:url(https://example.test/tracker.png);background-image:url(https://example.test/tracker2.png)"><table background="https://example.test/legacy.png"><tr><td>Keep layout</td></tr></table></div>')]))
  assert.match(result.html, /style="color:red"/)
  assert.match(result.html, /<table><tr><td>Keep layout/)
  assert.doesNotMatch(result.html, /background|url\(|tracker|legacy/)
})

test("plain-only originals use escaped text in HTML and keep line breaks", () => {
  const result = render(quoteInput([part("text/plain", "First <unsafe> & line\nSecond line")]))
  assert.match(result.html, /First &lt;unsafe&gt; &amp; line<\/div><div>Second line/)
  assert.match(result.plain, /> First <unsafe> & line\n> Second line/)
})

test("HTML-only originals keep block element boundaries in the plain fallback", () => {
  const result = render(quoteInput([part("text/html", "<div>First</div><div>Second<br>Third</div><p>Fourth</p>")]))
  assert.match(result.plain, /> First\n> Second\n> Third\n> Fourth/)
})

test("attribution uses the requested IANA time zone and links the sender email", () => {
  const result = render({ ...quoteInput(), timeZone: "America/New_York" })
  assert.match(result.plain, /On Wed, Oct 14, 2026 at 12:50 PM Example Sender <sender@example.test> wrote:/)
  assert.match(result.html, /Example Sender &lt;<a href="mailto:sender@example.test">sender@example.test<\/a>&gt; wrote:/)
})

test("attribution without a time zone preserves the original Date offset, not host time or UTC", () => {
  const result = buildGmailQuote({ from, date: "Thu, 15 Oct 2026 00:20:00 +0530", body: "Original" })
  assert.equal(result.attribution, `On Thu, Oct 15, 2026 at 12:20 AM ${from} wrote:`)
})

test("attribution observes the daylight-saving transition", () => {
  const before = buildGmailQuote({ from, date: "Sun, 08 Mar 2026 06:59:00 +0000", body: "Original", timeZone: "America/New_York" })
  const after = buildGmailQuote({ from, date: "Sun, 08 Mar 2026 07:01:00 +0000", body: "Original", timeZone: "America/New_York" })
  assert.match(before.attribution, /at 1:59 AM/)
  assert.match(after.attribution, /at 3:01 AM/)
})

test("the last non-draft message supplies both quote and reply headers", () => {
  const draft = { labelIds: ["DRAFT"], payload: { headers: [{ name: "From", value: "Draft author" }, { name: "Message-ID", value: "<draft@example.test>" }], parts: [part("text/plain", "Unsent content")] } }
  const thread = { messages: [message(), draft] }
  assert.equal(extractGmailThreadQuoteInput(thread)?.from, from)
  assert.deepEqual(extractGmailThreadReplyContext(thread), { lastMessageId: "<sent@example.test>", references: "<root@example.test> <sent@example.test>" })
  assert.equal(extractGmailThreadQuoteInput({ messages: [draft] }), null)
  assert.equal(extractGmailThreadReplyContext({ messages: [draft] }), null)
})

test("an empty sanitized HTML part falls back to escaped original plain text", () => {
  const result = render(quoteInput([part("text/plain", "Keep this <text>"), part("text/html", "<script>bad()</script>")]))
  assert.match(result.html, /Keep this &lt;text&gt;/)
  assert.doesNotMatch(result.html, /bad\(\)/)
})

test("sender names and mailto attributes cannot inject HTML", () => {
  const result = render({ from: '"<img src=x onerror=bad()>" <sender@example.test>', date, body: "Original" })
  assert.match(result.html, /&lt;img src=x onerror=bad\(\)&gt;/)
  assert.doesNotMatch(result.html, /<img/)
})

test("original negative and obsolete Date offsets retain their wall-clock time", () => {
  for (const zone of ["-0400", "EDT"]) {
    assert.equal(buildGmailQuote({ from, date: `Wed, 14 Oct 2026 12:50:00 ${zone}`, body: "Original" }).attribution, `On Wed, Oct 14, 2026 at 12:50 PM ${from} wrote:`)
  }
})

test("authored markdown and attribute escaping coexist with independent plain and CID-only HTML quotes", () => {
  const body = '**Ready** [Guide](https://example.test/?a=1&b=2)\nThanks,\nExample'
  for (const html of [undefined, '<div>Original **literal**<img src="https://example.test/tracker.png"><img src="cid:diagram@example.test"></div>']) {
    const raw = buildGmailDraftRaw({
      to: "recipient@example.test", subject: "Re: Synthetic conversation", body,
      quote: buildGmailQuote({ from, date, body: "**Original** <raw>", html, timeZone: "America/New_York" }),
    })
    const rendered = mimePart(raw, "text/html")
    assert.match(rendered, /<strong>Ready<\/strong>/)
    assert.match(rendered, /href="https:\/\/example.test\/\?a=1&amp;b=2"/)
    assert.match(rendered, /Thanks,<\/div><div[^>]*>Example<\/div>/)
    assert.match(rendered, /On Wed, Oct 14, 2026 at 12:50 PM/)
    assert.match(mimePart(raw, "text/plain"), /> \*\*Original\*\* <raw>/)
    assert.doesNotMatch(rendered, /<strong>Original|tracker\.png/)
    if (html) assert.match(rendered, /src="cid:diagram@example.test"/)
    else assert.match(rendered, /\*\*Original\*\* &lt;raw&gt;/)
  }
})

test("quote size limits and caller-provided quoted-history detection remain in place", () => {
  const quote = buildGmailQuote({ from, date, body: "x".repeat(10_001), html: `<div>${"y".repeat(20_000)}</div>` })
  assert.equal(quote.body, `${"x".repeat(10_000)}\n[message trimmed]`)
  assert.ok(quote.html && quote.html.length < 10_200)
  assert.match(quote.html, /\[message trimmed\]/)
  assert.equal(gmailBodyHasQuotedHistory("Already wrote:\n> Original"), true)
  assert.equal(gmailBodyHasQuotedHistory("New prose"), false)
})
