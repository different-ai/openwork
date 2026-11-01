import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
let mounted: { root: Root; container: HTMLElement } | null = null
afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
})
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

const { ComposerBackgroundTasks } = await import("../src/react-app/domains/session/surface/composer/composer-background-tasks")

function shell(id: string, command: string, startedAt: number) {
  return { id, sessionId: "ses_1", command, startedAt, observedAt: Date.now() }
}

async function render(shells: ReturnType<typeof shell>[], syncDegraded = false) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(ComposerBackgroundTasks, { shells, syncDegraded })))
  return container
}

test("running commands get the Agents list's header and one row each, the command in monospace", async () => {
  const now = Date.now()
  const container = await render([shell("sh_1", "pnpm export:report", now - 12_000), shell("sh_2", "node resize.js", 0)])
  expect(container.querySelector("[data-background-tasks]")?.getAttribute("data-background-tasks")).toBe("2")
  expect(container.querySelector('[data-testid="background-tasks-toggle"]')?.textContent).toBe("Background tasks2 running")
  const rows = [...container.querySelectorAll("[data-background-task]")]
  expect(rows.map((row) => row.querySelector("code")?.textContent)).toEqual(["pnpm export:report", "node resize.js"])
  expect(rows[0]?.querySelector("[data-background-task-status]")?.textContent).toMatch(/^Running \d+s$/)
  expect(rows[0]?.querySelector(".ow-text-shimmer")).not.toBeNull()
  expect(rows[1]?.querySelector("[data-background-task-status]")?.textContent).toBe("Running")
})

test("more than three commands start collapsed; the header opens them", async () => {
  const now = Date.now()
  const container = await render([1, 2, 3, 4].map((n) => shell(`sh_${n}`, `job ${n}`, now)))
  const list = container.querySelector<HTMLElement>("[data-background-task]")?.parentElement
  expect(list?.hidden).toBe(true)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="background-tasks-toggle"]')?.click())
  expect(list?.hidden).toBe(false)
})

test("a connection that cannot confirm the commands keeps them listed, without shimmer or time", async () => {
  const container = await render([shell("sh_1", "pnpm export:report", Date.now() - 5_000)], true)
  expect(container.querySelectorAll(".ow-text-shimmer")).toHaveLength(0)
  expect(container.querySelector("[data-background-task-status]")?.textContent).toBe("Reconnecting")
})

test("nothing running, nothing shown", async () => {
  const container = await render([])
  expect(container.innerHTML).toBe("")
})
