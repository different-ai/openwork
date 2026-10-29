import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { highlightRuns, loadPaletteRecents, matchIndexes, rankPaletteItems, recordPaletteRecent, SEARCH_LIMIT, type Rankable } from "../../../packages/workbot-ui/src/command-palette-search.js"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

const PUBLIC = "http://localhost:3090"

async function me(session: Record<string, unknown>) {
  const config = loadConfig({ WORKBOT_PUBLIC_URL: PUBLIC, WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: "http://localhost:3092", WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, { config, den, sameOrigin: createAuth({ config, den }).sameOrigin, member: async (c, next) => {
    const who = denSessionSchema.parse({ user: { id: "user_example", name: "Example", email: "member@example.test" }, organization: { id: "org_example", name: "Example workspace", brandAppName: null }, memberId: "member_example", canSchedule: false, ...session })
    c.set("member", { session: { id: "session_example", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture-token", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "fixture-token", den: who })
    await next()
  } })
  const body: unknown = await (await app.request(`${PUBLIC}/v1/workbot/me`, { headers: { origin: PUBLIC } })).json()
  assert.ok(typeof body === "object" && body !== null && "commandPalette" in body)
  return body.commandPalette
}

test("the palette is available by default regardless of legacy Den rollout values", async () => {
  assert.equal(await me({ enabled: true }), true, "older Dens may omit the compatibility field")
  assert.equal(await me({ enabled: true, commandPalette: false }), true, "retired rollout values cannot hide the palette")
  assert.equal(await me({ enabled: true, commandPalette: true }), true)
  assert.equal(await me({ enabled: false, commandPalette: false }), true, "Workbot access is enforced separately from the palette compatibility field")
})

const items: Rankable[] = [
  { id: "action:new-side-chat", group: "actions", title: "New side chat", keywords: "start create conversation topic" },
  { id: "action:tasks", group: "actions", title: "Show background tasks", keywords: "jobs work progress" },
  { id: "chat:budget", group: "chats", title: "Budget review", keywords: "side chat conversation" },
  { id: "chat:launch", group: "chats", title: "Launch plan", keywords: "side chat conversation" },
  { id: "chat:old", group: "chats", title: "Old notes", keywords: "side chat conversation", preview: false },
  { id: "nav:calendar", group: "navigation", title: "Calendar", keywords: "week meetings schedule automations" },
  { id: "settings:connections", group: "settings", title: "Your connections", keywords: "apps google microsoft calendar connect" },
]

test("with nothing typed, recent entries come first, then each group in order, without search-only entries", () => {
  const groups = rankPaletteItems("", items, ["nav:calendar", "gone"])
  assert.deepEqual(groups.map((group) => group.value), ["recent", "actions", "chats", "settings"])
  assert.deepEqual(groups[0]?.items.map((item) => item.id), ["nav:calendar"], "a recent id that no longer exists is skipped")
  assert.ok(!groups.flatMap((group) => group.items).some((item) => item.id === "chat:old"), "older chats appear only when searched")
})

test("search ranks a title match above a keyword match, leads with the best group and finds search-only entries", () => {
  const calendar = rankPaletteItems("calendar", items, [])
  assert.equal(calendar[0]?.items[0]?.id, "nav:calendar", "the Calendar page beats the connections row that mentions calendars")
  assert.equal(calendar[0]?.value, "navigation")
  assert.equal(rankPaletteItems("old", items, [])[0]?.items[0]?.id, "chat:old")
  assert.deepEqual(rankPaletteItems("xyzzy", items, []), [])
  assert.equal(rankPaletteItems("bud", items, [])[0]?.items[0]?.id, "chat:budget")
})

test("a recently used entry wins a tie, and a long list stays short", () => {
  const twins: Rankable[] = [{ id: "a", group: "chats", title: "Plan" }, { id: "b", group: "chats", title: "Plan" }]
  assert.equal(rankPaletteItems("plan", twins, ["b"])[0]?.items[0]?.id, "b")
  const many: Rankable[] = Array.from({ length: 500 }, (_, index) => ({ id: `chat:${index}`, group: "chats", title: `Weekly report ${index}` }))
  assert.equal(rankPaletteItems("weekly", many, []).flatMap((group) => group.items).length, SEARCH_LIMIT)
})

test("matched letters are emphasized in order, as plain text runs", () => {
  assert.deepEqual(highlightRuns("Budget review", matchIndexes("bud", "Budget review")), [{ text: "Bud", match: true }, { text: "get review", match: false }])
  assert.deepEqual(highlightRuns("Calendar", matchIndexes("", "Calendar")), [{ text: "Calendar", match: false }])
})

test("recents keep the newest eight, once each, and survive unreadable storage", () => {
  const store = new Map<string, string>()
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
  for (const id of ["a", "b", "c", "a", "d", "e", "f", "g", "h", "i"]) recordPaletteRecent(id, storage)
  assert.deepEqual(loadPaletteRecents(storage), ["i", "h", "g", "f", "e", "d", "a", "c"])
  store.set("workbot.command-palette.recents", "{not json")
  assert.deepEqual(loadPaletteRecents(storage), [])
  const failing = { getItem: () => null, setItem: () => { throw new Error("quota") } }
  assert.deepEqual(recordPaletteRecent("x", failing), ["x"], "running an action never depends on storage")
})
