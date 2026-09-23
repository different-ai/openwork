import assert from "node:assert/strict"
import test from "node:test"

import { classifyPr, cleanBody, extractReleaseNote, parseCommits, renderMarkdown, stripHtmlComments } from "./collect-release-prs.mjs"

test("commit subjects map to their squash-merged PR numbers", () => {
  const commits = parseCommits("aaa\tfeat(server): add web command (#5212)\nbbb\tHotfix without a PR\n")
  assert.deepEqual(commits, [
    { hash: "aaa", subject: "feat(server): add web command (#5212)", pr: 5212 },
    { hash: "bbb", subject: "Hotfix without a PR", pr: null },
  ])
})

test("review tooling, CI, and test-only PRs are internal even with feat titles", () => {
  const preview = classifyPr({
    title: "feat(preview): resume running ACME worlds",
    paths: [".github/workflows/freestyle-prewarm.yml", "apps/review/app/route.ts", "packages/freestyle/src/index.ts", "worlds/acme-web.md", "evals/specs/acme.e2e.test.ts"],
    releaseNote: null,
  })
  assert.equal(preview.audience, "internal")

  const warden = classifyPr({ title: "Simplify Warden", paths: [".warden/README.md", "AGENTS.md", "warden.toml"], releaseNote: null })
  assert.equal(warden.audience, "internal")
})

test("PRs touching the app, server, or Den are product changes", () => {
  const chat = classifyPr({
    title: "fix(chat): never dead-end a connection question",
    paths: ["apps/app/src/components/chat/connection-card.tsx", "apps/app/tests/connection-card.test.tsx"],
    releaseNote: null,
  })
  assert.equal(chat.audience, "product")
})

test("website-only PRs are separated from product changes", () => {
  const website = classifyPr({
    title: "feat(website): refresh branding",
    paths: ["ee/apps/landing/app/page.tsx", "packages/docs/index.mdx", "ee/apps/den-api/scripts/openapi.ts", ".github/pr-assets/a.png"],
    releaseNote: null,
  })
  assert.equal(website.audience, "website")
})

test("an author's explicit 'none' release note marks the PR internal", () => {
  const body = "## What is this about?\nRefactor.\n\n## Release note\nnone\n\n## Evidence\n- tests"
  const note = extractReleaseNote(body)
  assert.equal(note, "none")
  assert.equal(classifyPr({ title: "refactor(app): tidy", paths: ["apps/app/src/a.ts"], releaseNote: note }).audience, "internal")
})

test("release note sections ignore template comments and stop at the next heading", () => {
  const body = "## Release note\n<!-- one sentence -->\nYou can now self-host with one command.\n## Evidence\nproof"
  assert.equal(extractReleaseNote(body), "You can now self-host with one command.")
  assert.equal(extractReleaseNote("## Summary\nno note here"), null)
})

test("previous changelog PRs are skipped entirely", () => {
  assert.equal(classifyPr({ title: "docs(changelog): release notes for v0.18.49", paths: ["packages/docs/changelog.mdx"], releaseNote: null }).audience, "skip")
})

test("bodies lose images and comments and are truncated", () => {
  const body = `<!-- template -->\nBefore ![shot](https://x/y.png) after <img src="z">\n\n\n\nEnd ${"x".repeat(50)}`
  const cleaned = cleanBody(body, 30)
  assert(!cleaned.includes("template"))
  assert(!cleaned.includes("png"))
  assert(cleaned.endsWith("…"))
})

test("markdown lists internal PRs by title only and product PRs with their description", () => {
  const markdown = renderMarkdown({
    prev: "v1.0.0",
    tag: "v1.0.1",
    prs: [
      { number: 1, title: "feat(app): thing", areas: ["apps/app"], audience: "product", reason: "touches product code", author: "a", releaseNote: null, body: "Users can now do the thing." },
      { number: 2, title: "ci: speed up", areas: [".github/workflows"], audience: "internal", reason: "CI", author: "b", releaseNote: null, body: "" },
    ],
    commitsWithoutPr: [],
  })
  assert(markdown.includes("## Product (1)"))
  assert(markdown.includes("> Users can now do the thing."))
  assert(markdown.includes("- #2 ci: speed up (.github/workflows)"))
})

test("HTML comments are fully stripped, even with overlapping or unterminated markers", () => {
  assert.equal(stripHtmlComments("a<!-- one -->b<!-- two -->c"), "abc")
  assert.equal(stripHtmlComments("<!<!--x-->--"), "")
  assert.equal(stripHtmlComments("keep <!<!--x-->-- this"), "keep ")
  assert.equal(stripHtmlComments("text <!-- never closed"), "text ")
  assert.equal(stripHtmlComments("no comments"), "no comments")
  for (const input of ["<!<!--x-->--", "<<!--!--a-->--b-->", "<!--<!---->-->x"]) {
    assert(!stripHtmlComments(input).includes("<!--"), input)
  }
  assert.equal(extractReleaseNote("## Release note\n<!<!--x-->-- hint -->\nShip it.\n## Evidence"), "Ship it.")
})
