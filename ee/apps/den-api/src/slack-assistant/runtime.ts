import { z } from "zod"
import { DEFAULT_REMOTE_SESSION_DEPS, type RemoteSessionRuntime } from "../mcp/remote-session-capabilities.js"
import { fetchPreviewNoRedirect, previewFetch } from "../workers/preview-fetch.js"
import type { SlackActor } from "./repository.js"

async function runtimeRequest(runtime: RemoteSessionRuntime, path: string, method = "GET", body?: unknown) {
  const response = await fetchPreviewNoRedirect(
    previewFetch(),
    `${runtime.baseUrl.replace(/\/$/, "")}/workspace/${encodeURIComponent(runtime.workspaceId)}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${runtime.clientToken}`,
        "X-OpenWork-Host-Token": runtime.hostToken,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) throw new Error("slack_runtime_request_failed")
  return response.json()
}
export async function slackRuntime(actor: SlackActor) {
  if (!(await DEFAULT_REMOTE_SESSION_DEPS.getOpenWorkWebAccess(actor.organizationId)).hasAccess)
    throw new Error("openwork_web_access_required")
  const result = await DEFAULT_REMOTE_SESSION_DEPS.resolveRuntime({
    organizationId: actor.organizationId,
    userId: actor.userId,
  })
  if (!result.ok) throw new Error("slack_runtime_unavailable")
  return result.runtime
}
export async function slackSessionNeedsAttention(actor: SlackActor, sessionId: string) {
  const runtime = await slackRuntime(actor)
  const schema = z.array(z.object({ sessionID: z.string() }))
  const [permissions, questions] = await Promise.all([
    runtimeRequest(runtime, "/opencode/permission"),
    runtimeRequest(runtime, "/opencode/question"),
  ])
  return [...schema.parse(permissions), ...schema.parse(questions)].some((item) => item.sessionID === sessionId)
}
export async function organizeSlackSession(actor: SlackActor, sessionId: string) {
  const runtime = await slackRuntime(actor)
  const schema = z.object({ state: z.object({ groups: z.array(z.object({ id: z.string(), label: z.string() })) }) })
  const groups = schema.parse(await runtimeRequest(runtime, "/session-groups"))
  let groupId = groups.state.groups.find((group) => group.label === "Slack")?.id
  if (!groupId) {
    const result = schema.parse(await runtimeRequest(runtime, "/session-groups", "POST", { label: "Slack" }))
    groupId = result.state.groups.find((group) => group.label === "Slack")?.id
  }
  if (groupId)
    await runtimeRequest(runtime, `/session-groups/assignments/${encodeURIComponent(sessionId)}`, "PATCH", { groupId })
}
export async function renameSlackSession(actor: SlackActor, sessionId: string, title: string) {
  await runtimeRequest(await slackRuntime(actor), `/opencode/session/${encodeURIComponent(sessionId)}`, "PATCH", {
    title: title.slice(0, 120),
  })
}
