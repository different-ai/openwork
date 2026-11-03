#!/usr/bin/env node
// Renders a Markdown doc with Mermaid diagrams to a shareable PDF.
//
//   pnpm docs:pdf docs/security/openwork-architecture.md [output.pdf]
//
// Uses only dependencies already locked in this repository (`marked` and
// `mermaid`, resolved through apps/app) plus an installed Google Chrome or
// Chromium for printing. Nothing is downloaded at build time. Set CHROME_PATH
// to choose a browser. The default output is `<doc dir>/dist/<name>.pdf`,
// which git ignores.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const appRequire = createRequire(join(repoRoot, "apps/app/package.json"))

function fail(message) {
  console.error(`docs:pdf: ${message}`)
  process.exit(1)
}

const [inputArg, outputArg] = process.argv.slice(2)
if (!inputArg) fail("usage: pnpm docs:pdf <doc.md> [output.pdf]")
const input = resolve(process.cwd(), inputArg)
if (!existsSync(input)) fail(`not found: ${inputArg}`)
const output = outputArg
  ? resolve(process.cwd(), outputArg)
  : join(dirname(input), "dist", `${basename(input, extname(input))}.pdf`)

function resolvePackageFile(name, file) {
  try {
    return join(dirname(appRequire.resolve(`${name}/package.json`)), file)
  } catch {
    fail(`cannot find ${name}; run pnpm install first`)
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" })
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim()
  }
  fail("Chrome or Chromium not found; set CHROME_PATH")
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** GitHub-style heading anchor, so in-document links work in the PDF too. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-")
}

function gitStamp(file) {
  const run = (args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" })
  const sha = run(["rev-parse", "--short", "HEAD"]).stdout.trim() || "unknown"
  const path = relative(repoRoot, file)
  const dirty = run(["status", "--porcelain", "--", path]).stdout.trim() !== ""
  return { sha, path, dirty }
}

const { Marked } = await import(pathToFileURL(resolvePackageFile("marked", "lib/marked.esm.js")).href)
const mermaidSource = await readFile(resolvePackageFile("mermaid", "dist/mermaid.min.js"), "utf8")
const markdown = await readFile(input, "utf8")

let diagramCount = 0
/** Only plain web, mail and in-document links survive; anything else (javascript:, data:, file:) renders as text. */
const SAFE_HREF = /^(https?:|mailto:|#)/i
const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      if (lang !== "mermaid") return false
      diagramCount += 1
      return `<div class="diagram"><pre class="mermaid">${escapeHtml(text)}</pre></div>\n`
    },
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`
    },
    // The doc is rendered in a browser: raw HTML is shown as text, never executed.
    html({ text }) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens)
      if (!SAFE_HREF.test(href.trim())) return label
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`
    },
    image({ text }) {
      return escapeHtml(text)
    },
  },
})

const body = marked.parse(markdown)
const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? basename(input)
const stamp = gitStamp(input)
const built = new Date().toISOString().slice(0, 10)
const cssString = (text) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`

const mermaidScript = mermaidSource.replace(/<\/script/gi, "<\\/script")
const layoutScript = `
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", flowchart: { useMaxWidth: true }, sequence: { useMaxWidth: true } })
  const isHeading = (node) => /^H[1-3]$/.test(node.tagName)
  mermaid.run({ querySelector: "pre.mermaid" })
    .then(() => {
      for (const diagram of document.querySelectorAll(".diagram")) {
        // The heading and lead-in text that introduce this diagram.
        const lead = []
        let node = diagram.previousElementSibling
        while (node && !node.classList.contains("diagram")) {
          lead.unshift(node)
          if (isHeading(node)) break
          node = node.previousElementSibling
        }
        const heading = lead.length && isHeading(lead[0]) ? lead[0] : null
        const box = diagram.querySelector("svg")?.viewBox?.baseVal
        if (box && box.width >= box.height * 1.8) {
          // Very wide diagrams print on their own landscape page, with their heading.
          diagram.classList.add("landscape")
          if (heading) diagram.prepend(...lead)
        } else if (heading && heading.tagName === "H2") {
          // Every other diagram section starts on a fresh page.
          heading.classList.add("page-start")
        }
      }
      document.body.dataset.rendered = String(document.querySelectorAll(".diagram svg").length)
    })
    .catch((error) => { document.body.dataset.renderError = String(error && error.message || error) })
`
const scriptHash = (source) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`
const csp = `default-src 'none'; script-src ${scriptHash(mermaidScript)} ${scriptHash(layoutScript)}; style-src 'unsafe-inline'; img-src data:; font-src data:`
const footer = `font: 7.5pt -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #94a3b8;`

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
<style>
  @page {
    size: A4;
    margin: 18mm 16mm 20mm;
    @bottom-left { content: ${cssString(title)}; ${footer} }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); ${footer} }
  }
  @page landscape {
    size: A4 landscape;
    margin: 14mm 16mm 16mm;
    @bottom-left { content: ${cssString(title)}; ${footer} }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); ${footer} }
  }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 10pt/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; }
  .stamp { font-size: 7.5pt; color: #94a3b8; letter-spacing: 0.01em; margin-bottom: 26px; }
  h1 { font-size: 24pt; line-height: 1.15; margin: 0 0 10px; letter-spacing: -0.02em; }
  h2 { font-size: 15pt; line-height: 1.25; margin: 30px 0 10px; padding-top: 10px; border-top: 1px solid #e2e8f0; break-after: avoid; }
  h2.page-start, .diagram.landscape > h2 { break-before: page; margin-top: 0; padding-top: 0; border-top: none; }
  h3 { font-size: 11.5pt; margin: 22px 0 8px; break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  p { margin: 0 0 10px; }
  a { color: #5b21b6; text-decoration: none; }
  strong { font-weight: 600; }
  code { font: 8.5pt ui-monospace, SFMono-Regular, Menlo, monospace; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
  pre:not(.mermaid) { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; break-inside: avoid; }
  pre:not(.mermaid) code { background: none; padding: 0; }
  blockquote { margin: 16px 0; padding: 10px 14px; background: #f8f7ff; border-left: 3px solid #7c3aed; border-radius: 0 6px 6px 0; break-inside: avoid; }
  blockquote p { margin: 0; }
  ol, ul { padding-left: 22px; margin: 0 0 12px; }
  li { margin: 3px 0; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0 18px; font-size: 8.5pt; line-height: 1.45; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { border-bottom: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; color: #334155; border-top: 1px solid #e2e8f0; }
  td:first-child { font-weight: 500; }
  .diagram { margin: 14px 0 18px; break-inside: avoid; text-align: center; }
  .diagram svg { max-width: 100% !important; width: 100%; height: auto; max-height: 190mm; }
  .diagram.landscape { page: landscape; margin: 0; text-align: left; }
  .diagram.landscape svg { display: block; margin: 0 auto; max-height: 150mm; }
  pre.mermaid { margin: 0; background: none; border: none; padding: 0; }
</style>
</head>
<body>
<div class="stamp">${escapeHtml(stamp.path)} · commit ${escapeHtml(stamp.sha)}${stamp.dirty ? " + uncommitted changes" : ""} · built ${built}</div>
${body}
<script>${mermaidScript}</script>
<script>${layoutScript}</script>
</body>
</html>`

const chrome = findChrome()
const work = await mkdtemp(join(tmpdir(), "docs-pdf-"))
try {
  const htmlFile = join(work, "doc.html")
  await writeFile(htmlFile, html)
  const chromeArgs = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${join(work, "profile")}`,
    "--virtual-time-budget=20000",
  ]
  const url = pathToFileURL(htmlFile).href

  // Check every diagram rendered before printing.
  const dom = spawnSync(chrome, [...chromeArgs, "--dump-dom", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (dom.status !== 0) fail(`Chrome failed: ${dom.stderr.trim().split("\n").pop()}`)
  const renderError = dom.stdout.match(/data-render-error="([^"]*)"/)?.[1]
  if (renderError) fail(`Mermaid error: ${renderError}`)
  const rendered = Number(dom.stdout.match(/data-rendered="(\d+)"/)?.[1] ?? "0")
  if (rendered !== diagramCount) fail(`rendered ${rendered} of ${diagramCount} diagrams`)

  await mkdir(dirname(output), { recursive: true })
  const pdf = spawnSync(chrome, [...chromeArgs, "--no-pdf-header-footer", `--print-to-pdf=${output}`, url], { encoding: "utf8" })
  if (pdf.status !== 0 || !existsSync(output)) fail(`Chrome could not print the PDF: ${pdf.stderr.trim().split("\n").pop()}`)
  console.log(`docs:pdf: ${relative(process.cwd(), output)} (${rendered} diagrams, commit ${stamp.sha}${stamp.dirty ? "+dirty" : ""})`)
} finally {
  await rm(work, { recursive: true, force: true })
}
