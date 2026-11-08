import { WorkbotScreen, type WorkbotHost } from "@openwork-ee/workbot-ui"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import "../src/client/styles.css"

/**
 * Test-only page: the real Workbot screen against the in-memory conversation in chat-screen-server.ts, to check the
 * chat at a phone's size without Den or a runner. `?scenario=<name>` picks the conversation; other query values turn
 * host switches on (`?browser=1`).
 */
const search = new URLSearchParams(window.location.search)
const scenario = search.get("scenario") ?? "bubbles"
const headers = () => new Headers({ "x-fixture-scenario": scenario })
const host: WorkbotHost = {
  async requestJson(path, init = {}) {
    const merged = headers()
    new Headers(init.headers).forEach((value, key) => merged.set(key, value))
    if (init.body) merged.set("Content-Type", "application/json")
    const response = await fetch(path, { ...init, headers: merged })
    return { response, payload: await response.json().catch(() => null) }
  },
  async prepare(path) {
    return { url: path, headers: headers(), credentials: "same-origin" }
  },
  user: { name: "Sam Rivera" },
  useConnectedApps: () => [],
  appIcons: () => [],
  homeHref: "/",
  sideChats: search.get("sideChats") === "1",
  browser: search.get("browser") === "1",
  computer: search.get("computer") === "1",
  workingStatus: search.get("working") === "1",
  profileSheet: search.get("profile") === "1",
  centeredProfile: search.get("centered") === "1",
  browserPreview: search.get("preview") === "1",
  quickReply: search.get("quick") === "1",
  instantOpen: search.get("instant") === "1",
  scrollToBottom: search.get("scroll") === "1",
  remoteTasks: search.get("remote") === "1",
  connectionsHref: "https://den.example.test/dashboard/your-connections",
  identity: { principalId: "user_fixture", organizationId: "org_fixture" },
}

// Past the welcome: the fixture's hello has this time.
window.localStorage.setItem("workbot.welcomed", "1")
const queries = new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false } } })
const root = document.getElementById("root")
if (root) createRoot(root).render(<QueryClientProvider client={queries}><WorkbotScreen host={host} /></QueryClientProvider>)
