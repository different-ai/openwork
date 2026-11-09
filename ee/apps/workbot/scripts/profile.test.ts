import assert from "node:assert/strict"
import { test } from "node:test"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { readWorkbotMemory, type WorkbotActor } from "@openwork-ee/workbot-server"

const actor: WorkbotActor = { organizationId: "org_example", organizationName: "Example", organizationMetadata: {}, memberId: "member_profile", userId: "user_profile", firstName: "Sam" }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("Workbot's profile reads only its memory files, newest first", async () => {
  const read: string[] = []
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "t".repeat(32) }, mintToken: async () => ({ token: "mcp" }), maxTokenTtlMs: 60_000,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/v1/sessions") return json(200, { sessions: [] })
      if (url.pathname.endsWith("/files/content")) {
        const path = url.searchParams.get("path") ?? ""
        read.push(path)
        return new Response(path === "memory/about-me.md" ? "Founder. Prefers short answers." : "Q4 board deck", { status: 200 })
      }
      if (url.pathname.endsWith("/files")) {
        return json(200, { files: [
          { path: "memory/projects.md", size: 13, updatedAt: 100 },
          { path: "memory/about-me.md", size: 31, updatedAt: 300 },
          { path: "drafts/board-deck.md", size: 900, updatedAt: 400 },
          { path: "memory/archive/old.md", size: 10, updatedAt: 500 },
        ] })
      }
      return json(404, { error: "not_found" })
    },
  })
  const files = await readWorkbotMemory(actor, { client, canSchedule: async () => false })
  assert.deepEqual(files.map((file) => [file.name, file.updatedAt]), [["about-me.md", 300], ["projects.md", 100]])
  assert.equal(files[0]?.content, "Founder. Prefers short answers.")
  // Scratch work and nested folders are never read for the profile.
  assert.deepEqual(read.sort(), ["memory/about-me.md", "memory/projects.md"])
})

test("no conversation yet: nothing remembered", async () => {
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "t".repeat(32) }, mintToken: async () => ({ token: "mcp" }), maxTokenTtlMs: 60_000,
    fetch: async (input) => new URL(String(input)).pathname === "/v1/sessions" ? json(200, { sessions: [] }) : json(404, { error: "unknown_session" }),
  })
  assert.deepEqual(await readWorkbotMemory({ ...actor, memberId: "member_new" }, { client, canSchedule: async () => false }), [])
})
