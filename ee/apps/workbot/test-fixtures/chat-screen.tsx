import { WorkbotScreen, type WorkbotHost } from "@openwork-ee/workbot-ui"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import "../src/client/styles.css"
import { appIconCandidates } from "../src/client/app-icons"

/**
 * Test-only page: the real Workbot screen against the in-memory conversation in chat-screen-server.ts, to check the
 * chat at a phone's size without Den or a runner. `?scenario=<name>` picks the conversation; other query values turn
 * host switches on (`?browser=1`).
 */
const search = new URLSearchParams(window.location.search)
const scenario = search.get("scenario") ?? "bubbles"
// `?chatlist=1` answers the chats list with a few side chats, as a person who has used Workbot for a while sees it.
const headers = () => new Headers({ "x-fixture-scenario": scenario, ...(search.get("chatlist") === "1" ? { "x-fixture-chat-list": "1" } : {}) })
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
  // The same logos as the real page (Simple Icons, then favicons; no Den here).
  appIcons: (name, site) => appIconCandidates(name, null, site),
  homeHref: "/",
  sideChats: search.get("sideChats") === "1",
  browser: search.get("browser") === "1",
  computer: search.get("computer") === "1",
  scrollToBottom: search.get("scroll") === "1",
  calmChat: search.get("calm") === "1",
  // Devices rows say what Workbot is doing on each computer (`?deviceActivity=1`).
  deviceActivity: search.get("deviceActivity") === "1",
  // Documents and Calendar as Den turns them on for a workspace with the assistant (`?documents=1&calendar=1`).
  documents: search.get("documents") === "1",
  documentEditing: search.get("documents") === "1",
  calendar: search.get("calendar") === "1",
  workspaceAssistant: search.get("documents") === "1" || search.get("calendar") === "1",
  connectionsHref: "https://den.example.test/dashboard/your-connections",
  identity: { principalId: "user_fixture", organizationId: "org_fixture" },
}

// Past the welcome: the fixture's hello has this time.
window.localStorage.setItem("workbot.welcomed", "1")
const queries = new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false } } })
const root = document.getElementById("root")
if (root) createRoot(root).render(<QueryClientProvider client={queries}><WorkbotScreen host={host} /></QueryClientProvider>)
