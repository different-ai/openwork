import assert from "node:assert/strict"
import { test } from "node:test"
import { renderGmailDraftBody } from "../src/capability-sources/gmail-draft-body.ts"

// Exact HTML baselines captured from origin/dev f21153beb5 before the plain-only fix.
const li = (text: string) => `<li style="white-space:pre-wrap;overflow-wrap:anywhere">${text}</li>`
const div = (text: string) => `<div dir="ltr" style="white-space:pre-wrap;overflow-wrap:anywhere">${text}</div>`
const ul = (text: string) => `<ul dir="ltr" style="margin:0;padding-left:2em">${text}</ul>`
const ol = (text: string, start = 1) => `<ol${start === 1 ? "" : ` start="${start}"`} dir="ltr" style="margin:0;padding-left:2em">${text}</ol>`
const quote = (text: string) => `<blockquote dir="ltr" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${text}</blockquote>`

const cases = [
  {
    name: "ordered list keeps start and authored sequence",
    body: "3. Install\n4. Configure\n8. Test",
    plain: "3. Install\n4. Configure\n8. Test",
    html: ol(li("Install") + li("Configure") + li("Test"), 3),
  },
  {
    name: "nested mixed lists keep indentation and bullet markers",
    body: "- Parent\n  3. Child\n     * Leaf\n  4. Next\n- End",
    plain: "- Parent\n  3. Child\n     * Leaf\n  4. Next\n- End",
    html: ul(li("Parent" + ol(li("Child" + ul(li("Leaf"))) + li("Next"), 3)) + li("End")),
  },
  {
    name: "nested quotes prefix every line including empty lines",
    body: "> Outer\n>\n> > Inner\n> > Second\n> Back",
    plain: "> Outer\n> \n> > Inner\n> > Second\n> Back",
    html: quote(div("Outer") + "<div><br></div>" + quote(div("Inner") + div("Second")) + div("Back")),
  },
  {
    name: "quote containing a list keeps both structures",
    body: "> Plan:\n> 3. Install\n>    - Token\n> 4. Test",
    plain: "> Plan:\n> 3. Install\n>    - Token\n> 4. Test",
    html: quote(div("Plan:") + ol(li("Install" + ul(li("Token"))) + li("Test"), 3)),
  },
  {
    name: "fenced code drops fences but keeps code verbatim",
    body: "```ts\n  **literal** <tag>\n1. not a list\n> not a quote\n```",
    plain: "  **literal** <tag>\n1. not a list\n> not a quote",
    html: '<pre dir="ltr" style="white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-family:monospace">  **literal** &lt;tag&gt;\n1. not a list\n&gt; not a quote</pre>',
  },
  {
    name: "list after paragraph without blank line",
    body: "Plan:\n1. Install\n2. Test",
    plain: "Plan:\n1. Install\n2. Test",
    html: div("Plan:") + ol(li("Install") + li("Test")),
  },
  {
    name: "headings and inline formatting still lose syntax",
    body: "# Heading\n**bold** __strong__ *em* _em_ `code` [site](https://example.com)",
    plain: "Heading\nbold strong em em code site (https://example.com)",
    html: div("<strong>Heading</strong>") + div('<strong>bold</strong> <strong>strong</strong> <em>em</em> <em>em</em> <code>code</code> <a href="https://example.com">site</a>'),
  },
  {
    name: "table pipes remain aligned",
    body: "| Name | State |\n| --- | --- |\n| **API** | `ok` |",
    plain: "| Name | State |\n| ---- | ----- |\n| API  | ok    |",
    html: '<div dir="ltr"><table style="border-collapse:collapse"><tr><th style="border:1px solid #dadce0;padding:4px 8px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere">Name</th><th style="border:1px solid #dadce0;padding:4px 8px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere">State</th></tr><tr><td style="border:1px solid #dadce0;padding:4px 8px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere"><strong>API</strong></td><td style="border:1px solid #dadce0;padding:4px 8px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere"><code>ok</code></td></tr></table></div>',
  },
  {
    name: "tab indentation and authored asterisk bullet stay intact",
    body: "* First\n\t- Child\n- Last",
    plain: "* First\n\t- Child\n- Last",
    html: ul(li("First" + ul(li("Child"))) + li("Last")),
  },
  {
    name: "plus markers stay literal as before",
    body: "+ First\n  + Child",
    plain: "+ First\n  + Child",
    html: div("+ First") + div("  + Child"),
  },
]

for (const { name, body, plain, html } of cases) {
  test(`plain draft structure: ${name}`, () => {
    const rendered = renderGmailDraftBody(body, text => text)
    assert.equal(rendered.plain, plain)
  })
  test(`HTML unchanged: ${name}`, () => {
    assert.equal(renderGmailDraftBody(body, text => text).html, html)
  })
}
