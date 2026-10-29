import assert from "node:assert/strict"
import { test } from "node:test"
import { buildGmailDraftRaw } from "../src/capability-sources/gmail.ts"

function bodyParts(body: string): { plain: string; html: string } {
  const mime = Buffer.from(buildGmailDraftRaw({ to: "recipient@example.com", subject: "Draft body", body }), "base64url").toString("utf8")
  function part(type: string): string {
    const match = mime.match(new RegExp(`Content-Type: text/${type};[^\\r]+\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`))
    assert.ok(match, `missing ${type} MIME alternative`)
    return Buffer.from(match[1], "base64").toString("utf8")
  }
  return { plain: part("plain"), html: part("html") }
}

const wrapped = [
  "This paragraph is deliberately wrapped near seventy-two characters so that",
  "the draft builder can restore flowing prose without merging signatures or",
  "other blocks whose line breaks carry meaning.",
].join("\n")

for (const [name, body] of [
  ["signature", "Example Writer, Forward Deployed Engineer at Example Labs\nExample Company Inc., 548 Market St, San Francisco CA\nPhone +1 415 555 0100"],
  ["address", "Example Company headquarters and customer support office\n548 Market Street, Suite 100, San Francisco, California\nUnited States"],
  ["sign-off", "Thanks,\nExample"],
  ["long comma before short sign-off", "Thank you for the detailed investigation and thoughtful feedback,\nExample"],
  ["release-update paragraphs and sign-off", "Hi there,\n\nThanks again for the detailed analysis, you were spot on. Good news: both issues you reported are now fixed on our side.\n\nFirst issue: we reproduced it on our own test account, fixed it, and confirmed that the service now accepts the title requests.\nSecond issue: fixed as well, and tested against the real service. Session names are generated again.\nBoth fixes are merged and will ship in the next release.\n\nThanks,\nExample"],
  ["independent sentences", "The first issue is now fixed and verified against the live service.\nThe second issue is also fixed and verified against the live service.\nBoth fixes ship in the next release."],
  ["list", "- First item stays on its own line\n- Second item stays on its own line\n  continuation stays indented"],
  ["uneven long lines", "This deliberately long line is not evidence of wrapping by itself\nThis much longer line is a separate thought with a very different width and must remain on its own line\nA final line"],
]) {
  test(`draft body preserves ${name} line breaks in both alternatives`, () => {
    const { plain, html } = bodyParts(body)
    assert.equal(plain, body)
    assert.equal((html.match(/<div>/g) ?? []).length, body.split("\n").length)
  })
}

test("draft body joins genuine 72-column hard-wrapped prose", () => {
  const { plain, html } = bodyParts(wrapped)
  assert.equal(plain, wrapped.replaceAll("\n", " "))
  assert.equal((html.match(/<div>/g) ?? []).length, 1)
})

test("draft body normalizes CRLF without flattening blank lines", () => {
  const { plain, html } = bodyParts("Hello\r\n\r\nThanks,\r\nExample")
  assert.equal(plain, "Hello\n\nThanks,\nExample")
  assert.ok(html.includes("<div><br></div>"))
})
