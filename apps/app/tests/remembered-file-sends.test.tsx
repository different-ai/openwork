/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { FileSendGrants } from "../src/app/lib/openwork-server"

let createRoot: typeof import("react-dom/client")["createRoot"]
let RememberedFileSends: typeof import("../src/react-app/domains/settings/pages/computer-use-view")["RememberedFileSends"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
let root: Root | null = null
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  RememberedFileSends = (await import("../src/react-app/domains/settings/pages/computer-use-view")).RememberedFileSends
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })

const grants: FileSendGrants["grants"] = [
  { id: "grant_upload", kind: "drive_upload_file", account: "google-workspace", directory: "/Users/sam/reports", createdAt: "2026-11-12T10:00:00.000Z" },
  { id: "grant_push", kind: "drive_push_file", account: "source", directory: "/Users/sam/reports", createdAt: "2026-11-12T10:05:00.000Z" },
]

async function render(list: () => Promise<FileSendGrants>, remove: (id: string) => Promise<FileSendGrants> = async () => ({ enabled: true, grants: [] })) {
  const removed: string[] = []
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  const client = { listFileSendGrants: list, removeFileSendGrant: async (id: string) => { removed.push(id); return remove(id) } }
  await act(async () => root?.render(<RememberedFileSends client={client} />))
  return { element, removed }
}

test("nothing is shown until the member has chosen Always allow, or while the rollout is off", async () => {
  expect((await render(async () => ({ enabled: true, grants: [] }))).element.textContent).toBe("")
  await act(async () => root?.unmount())
  // A host with the rollout off holds no approvals to manage, whatever it returns.
  expect((await render(async () => ({ enabled: false, grants }))).element.textContent).toBe("")
})

test("each always-allowed send names its tool, folder and account, and Remove asks the host", async () => {
  const { element, removed } = await render(async () => ({ enabled: true, grants }), async () => ({ enabled: true, grants: [grants[1]!] }))
  expect(element.textContent).toContain("Always-allowed file sends")
  expect(element.textContent).toContain("Upload to Google Drive")
  expect(element.textContent).toContain("/Users/sam/reports")
  expect(element.textContent).toContain("google-workspace")
  expect(element.textContent).toContain("the account each file came from")
  const button = element.querySelector<HTMLButtonElement>('button[aria-label="Remove: Upload to Google Drive from /Users/sam/reports"]')
  await act(async () => button?.click())
  expect(removed).toEqual(["grant_upload"])
  expect(element.textContent).not.toContain("Upload to Google Drive")
  expect(element.textContent).toContain("Save files back to their drive")
})

test("a failed read shows no stale approvals and offers to try again", async () => {
  const { element } = await render(async () => { throw new Error("The server did not answer.") })
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Couldn't check always-allowed file sends. Try again. The server did not answer.")
  expect([...element.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Try again"])
})
