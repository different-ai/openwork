import { OFFICE_TTL_SECONDS } from "@openwork/documents/office-server"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { cloudHostingAvailable } from "./capability-sources/cloud-hosting.js"
import { env } from "./env.js"
import { getOpenWorkWebRuntimeAccess } from "./openwork-web-runtime-access.js"
import { cloudRuntimeAvailable, getCloudRuntime } from "./workers/cloud-runtime.js"
import { resolveCloudRuntimeAccess } from "./workers/worker-access.js"

/** Where an Office session's editor runs: the operator's service, or the member's Cloud worker. */
export type OfficeEditorPlacement =
  | { status: "ready"; serverUrl: string; workerId?: string }
  | { status: "starting"; message: string }
  | { status: "unavailable"; message: string }

export const OFFICE_EDITOR_STARTING = "Starting the document editor in your OpenWork Cloud workspace…"
const NOT_SET_UP = "Full document editing is not set up for this workspace. An administrator can enable the document editor. You can open this file in Drive."
const NO_CLOUD = "Full document editing runs in your OpenWork Cloud workspace, which isn't active for this organization. You can open this file in Drive."
const NEEDS_REPAIR = "Your OpenWork Cloud workspace needs repair before it can edit documents. Open OpenWork Web to let it recover, or open this file in Drive."

export type OfficeEditorPlacementDeps = {
  hostingAvailable(): boolean
  webAccess(organizationId: string): Promise<{ hasAccess: boolean }>
  resolveAccess: typeof resolveCloudRuntimeAccess
  ensureWorker(input: { organizationId: string; userId: string }): Promise<unknown>
  editorEndpoint(workerId: string): Promise<{ url: string } | null>
  now(): number
  sleep(ms: number): Promise<void>
}

const defaults: OfficeEditorPlacementDeps = {
  hostingAvailable: () => cloudHostingAvailable({ orgMode: env.orgMode, openworkWebEnabled: env.openworkWebEnabled }) && cloudRuntimeAvailable(),
  webAccess: getOpenWorkWebRuntimeAccess,
  resolveAccess: resolveCloudRuntimeAccess,
  async ensureWorker(input) {
    // Same creation path as remote sessions; loaded lazily to avoid a route import cycle.
    const { ensureMemberCloudWorker } = await import("./routes/cloud/index.js")
    await ensureMemberCloudWorker({ orgId: normalizeDenTypeId("organization", input.organizationId), createdByUserId: normalizeDenTypeId("user", input.userId) })
  },
  // The editor port gets its own signed URL; it outlives the four-hour session it serves.
  editorEndpoint: workerId => getCloudRuntime().portEndpoint(workerId, env.documentsOffice.workerPort, OFFICE_TTL_SECONDS + 15 * 60),
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/**
 * Resolves the member's Cloud worker the way OpenWork Web, remote sessions and
 * Cloud Automations do: an organization with Web access gets one created or
 * woken on first use. Waits briefly, then reports `starting` so the caller can retry.
 */
export async function placeOfficeEditor(
  input: { organizationId: string; userId: string },
  overrides: Partial<OfficeEditorPlacementDeps> = {},
  budgetMs = 6_000,
): Promise<OfficeEditorPlacement> {
  const config = env.documentsOffice
  if (config.mode === "fixed") return config.serverUrl ? { status: "ready", serverUrl: config.serverUrl } : { status: "unavailable", message: NOT_SET_UP }
  if (config.mode !== "cloud-worker") return { status: "unavailable", message: NOT_SET_UP }
  const deps = { ...defaults, ...overrides }
  if (!deps.hostingAvailable()) return { status: "unavailable", message: NOT_SET_UP }
  if (!(await deps.webAccess(input.organizationId)).hasAccess) return { status: "unavailable", message: NO_CLOUD }

  const deadline = deps.now() + budgetMs
  let created = false
  for (;;) {
    const access = await deps.resolveAccess({
      organizationId: normalizeDenTypeId("organization", input.organizationId),
      userId: normalizeDenTypeId("user", input.userId),
    })
    if (access.status === "missing" && !created) {
      created = true
      await deps.ensureWorker(input)
    }
    if (access.status === "failed") return { status: "unavailable", message: NEEDS_REPAIR }
    if (access.status === "ready") {
      const endpoint = await deps.editorEndpoint(access.workerId).catch(() => null)
      if (endpoint) return { status: "ready", serverUrl: endpoint.url, workerId: access.workerId }
    }
    if (deps.now() + 1_000 >= deadline) return { status: "starting", message: OFFICE_EDITOR_STARTING }
    await deps.sleep(1_000)
  }
}
