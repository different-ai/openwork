import { randomBytes, randomUUID } from "node:crypto"
import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { nativeOfficeFormats, officeFileTypeSchema, officeFormats, officeSessionSchema, officeStatusSchema } from "@openwork/documents/office-engine"
import { createCollaboraService, officeTicketMatches, validateOfficePackage, officeBytes, OFFICE_TTL_SECONDS, officeRecoveryUntil, officeSessionActive, type OfficeDraft } from "@openwork/documents/office-server"
import { documentIdSchema } from "@openwork/documents/model"
import { configuredOfficeStore } from "../../documents-office-store.js"
import { env } from "../../env.js"
import { getOrganizationContextForUser } from "../../orgs.js"
import { beginAuditRequest } from "../../audit/request-capture.js"
import { organizationFeatureEnabled } from "../../features.js"
import { orgMemberRoute, tokenRoute, paramValidator, jsonValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { requestGoogleAction, readGoogleActionJson, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import { canWriteDriveDocument } from "./google-document-scopes.js"
import type { OrgRouteVariables } from "./shared.js"

const ROOT = "/v1/documents/google-drive/files/:fileId/office"
const SERVICE = "/v1/documents/wopi/files/:sessionId"
const scope = "https://www.googleapis.com/auth/drive"
const READ = [scope, `${scope}.readonly`]
const params = z.object({ fileId: documentIdSchema })
const sessionParams = params.extend({ sessionId: z.string().uuid() })
const fileSchema = z.object({ id: documentIdSchema, name: z.string(), mimeType: z.string(), version: z.string(), trashed: z.boolean().optional(), capabilities: z.object({ canEdit: z.boolean().optional() }).optional() })
const failureSchema = z.object({ error: z.string(), message: z.string() })
type GoogleContext = Parameters<typeof requestGoogleAction>[0]
function validOrigin(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname)))) throw new Error("Documents requires HTTPS service origins (HTTP is limited to local development).")
  return url.origin
}
function configuredService() {
  const config = env.documentsOffice
  if (!config.serverUrl || !config.hostOrigin || !config.callbackBaseUrl) return null
  return createCollaboraService({ serverUrl: validOrigin(config.serverUrl), callbackBaseUrl: validOrigin(config.callbackBaseUrl), hostOrigin: validOrigin(config.hostOrigin) })
}

export function registerGoogleOfficeEditorRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, deps: GoogleWorkspaceActionDependencies) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const store = configuredOfficeStore()
  const service = configuredService()
  const enabled = async (id: string) => await organizationFeatureEnabled(id, "workbotDocuments") && await organizationFeatureEnabled(id, "workbot")
  const guard: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
    const context = c.get("organizationContext")
    if (!context || !await enabled(context.organization.id)) return c.json({ error: "feature_disabled", message: "Documents is off for this workspace." }, 403)
    if (!store || !service) return c.json({ error: "office_not_configured", message: "Full document editing is not set up for this workspace. An administrator can enable the document editor. You can open this file in Drive." }, 503)
    c.header("cache-control", "no-store")
    await next()
  }
  const description = (operationId: string, summary: string, schema: z.ZodType, security?: []) => {
    const options: DescribeRouteOptions & { "x-mcp": false } = { operationId, summary, description: security ? "Requires a file-bound WOPI capability and current workspace membership, feature and connector permissions. Reads and staged edits never write to Drive." : "Requires organization membership, Workbot and Documents, and the member’s authorized Drive connection. Saving explicitly commits the selected draft version; native Google files first create an Office copy.", tags: ["Documents"], "x-mcp": false, ...(security ? { security } : {}), responses: { 200: jsonResponse("Office editor result.", schema), 409: jsonResponse("Reopen or reconnect.", failureSchema), 503: jsonResponse("The editor is unavailable.", failureSchema) } }
    return describeRoute(options)
  }
  const failure = (c: GoogleContext, message: string) => c.json({ error: "office_unavailable", message }, 409)
  const selected = async (c: GoogleContext, connectionId?: string) => {
    const context = c.get("organizationContext")
    if (!context) throw new Error("Sign in to your workspace.")
    const token = await deps.token({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, connectionId: connectionId ?? null })
    if (token.kind !== "ok" || !token.connectionId) return { ok: false, reply: c.json({ error: token.kind === "policy_blocked" ? "policy_blocked" : "needs_connection", message: token.kind === "ok" ? "Connect Google Drive to open documents." : token.message }, 409) } as const
    return { ok: true, token, connectionId: token.connectionId, deps: { ...deps, fetch: (url: Parameters<typeof fetch>[0], init?: RequestInit) => deps.fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]) }), token: (input: Parameters<typeof deps.token>[0]) => deps.token({ ...input, connectionId: token.connectionId }) } } as const
  }
  const fileUrl = (id: string, suffix = "") => new URL(`/drive/v3/files/${id}${suffix}`, env.googleApiBaseUrl ?? "https://www.googleapis.com")
  const metadata = async (c: GoogleContext, selectedDeps: GoogleWorkspaceActionDependencies, id: string) => {
    const url = fileUrl(id); url.searchParams.set("fields", "id,name,mimeType,version,trashed,capabilities(canEdit)"); url.searchParams.set("supportsAllDrives", "true")
    const result = await requestGoogleAction(c, selectedDeps, READ, url)
    if (!result.ok) return result
    const file = fileSchema.parse(await readGoogleActionJson(result.response))
    if (file.id !== id || file.trashed) throw new Error("This file is unavailable or in the trash.")
    return { ok: true, file, etag: result.response.headers.get("etag") } as const
  }
  const owned = async (c: GoogleContext, id: string, fileId: string) => {
    const draft = await store?.get(id); const context = c.get("organizationContext")
    if (!draft || officeRecoveryUntil(draft) <= Date.now() || !context || draft.organizationId !== context.organization.id || draft.memberId !== context.currentMember.id || draft.fileId !== fileId) throw new Error("This editing session expired or belongs to another person. Reopen the file.")
    return draft
  }
  const serviceAuthorized = async (c: Parameters<MiddlewareHandler<{ Variables: OrgRouteVariables }>>[0], draft: OfficeDraft) => {
    const context = await getOrganizationContextForUser({ organizationId: normalizeDenTypeId("organization", draft.organizationId), userId: normalizeDenTypeId("user", draft.userId) })
    if (!context || context.currentMember.id !== draft.memberId || !await enabled(draft.organizationId)) return false
    c.set("organizationContext", context)
    const auth = await selected(c, draft.connectionId)
    if (!auth.ok) return false
    return (await metadata(c, auth.deps, draft.savedFileId ?? draft.fileId)).ok
  }

  app.post(ROOT, description("openGoogleDriveOfficeEditor", "Open a document, spreadsheet or presentation editor", officeSessionSchema), orgMemberRoute(), guard, bodyLimit({ maxSize: 1024 }), paramValidator(params), async c => {
    if (!store || !service) return failure(c, "The document editor is unavailable.")
    try {
      const { fileId } = c.req.valid("param"); const auth = await selected(c); if (!auth.ok) return auth.reply
      const meta = await metadata(c, auth.deps, fileId); if (!meta.ok) return meta.reply
      const native = Object.hasOwn(nativeOfficeFormats, meta.file.mimeType) ? nativeOfficeFormats[meta.file.mimeType] : null
      const fileType = native ?? officeFileTypeSchema.options.find(type => officeFormats[type].mimeType === meta.file.mimeType)
      if (!fileType) return failure(c, "Open a Word, Excel, PowerPoint or OpenDocument file, or a Google Doc, Sheet or Slides presentation.")
      const url = fileUrl(fileId, native ? "/export" : ""); url.searchParams.set(native ? "mimeType" : "alt", native ? officeFormats[fileType].mimeType : "media")
      const media = await requestGoogleAction(c, auth.deps, READ, url); if (!media.ok) return media.reply
      const bytes = await officeBytes(media.response); await validateOfficePackage(bytes, fileType)
      const latest = await metadata(c, auth.deps, fileId); if (!latest.ok) return latest.reply
      if (meta.file.version !== latest.file.version) return failure(c, "This file changed while opening. Open the latest version again.")
      const context = c.get("organizationContext")!
      const canWrite = canWriteDriveDocument(auth.token.account.scopes, auth.token.enabledScopes)
      const draft: OfficeDraft = {
        id: randomUUID(), organizationId: context.organization.id, memberId: context.currentMember.id, userId: context.currentMember.userId, connectionId: auth.connectionId,
        fileId, revision: meta.file.version, name: native ? `${meta.file.name}.${fileType}` : meta.file.name, mimeType: officeFormats[fileType].mimeType, fileType,
        canEdit: canWrite && (native !== null || meta.file.capabilities?.canEdit === true), saveAsCopy: native !== null,
        expiresAt: Date.now() + OFFICE_TTL_SECONDS * 1000, ticket: randomBytes(32).toString("base64url"), source: Buffer.from(bytes).toString("base64"), draftVersion: 0,
      }
      await store.lock(`member:${draft.organizationId}:${draft.memberId}`, () => store.put(draft))
      return c.json(await service.session(draft))
    } catch (error) { return failure(c, error instanceof Error ? error.message : "Couldn't open the full editor.") }
  })

  app.get(`${ROOT}/:sessionId`, description("getGoogleDriveOfficeEditorStatus", "Check whether an Office save is ready", officeStatusSchema), orgMemberRoute(), guard, paramValidator(sessionParams), async c => {
    try {
      const input = c.req.valid("param"); const draft = await owned(c, input.sessionId, input.fileId)
      const auth = await selected(c, draft.connectionId); if (!auth.ok) return auth.reply
      const check = await metadata(c, auth.deps, draft.savedFileId ?? draft.fileId); if (!check.ok) return check.reply
      return c.json({ expiresAt: new Date(draft.expiresAt).toISOString(), recoveryExpiresAt: new Date(officeRecoveryUntil(draft)).toISOString(), draftVersion: draft.draftVersion, saveRequestId: draft.saveRequestId, savedFileId: draft.savedFileId, uncertain: draft.uncertain === true })
    } catch (error) { return failure(c, error instanceof Error ? error.message : "Couldn't check the save.") }
  })

  app.post(`${ROOT}/:sessionId/save`, description("saveGoogleDriveOfficeEditor", "Save an Office snapshot to Drive", z.object({ fileId: documentIdSchema })), orgMemberRoute(), guard, paramValidator(sessionParams), jsonValidator(z.object({ draftVersion: z.number().int().min(0) }).strict()), async c => {
    if (!store) return failure(c, "The document editor is unavailable.")
    try {
      const expected = c.req.valid("json").draftVersion
      const input = c.req.valid("param"); const initial = await owned(c, input.sessionId, input.fileId)
      return await store.lock(`file:${initial.organizationId}:${initial.connectionId}:${initial.savedFileId ?? initial.fileId}`, () => store.lock(initial.id, async () => {
        const draft = await owned(c, initial.id, input.fileId)
        if (!officeSessionActive(draft)) return failure(c, "This editing session expired. Download the last received copy before recovery expires.")
        if (!draft.canEdit || draft.draftVersion !== expected || draft.uncertain) return failure(c, "Prepare your latest changes before saving. An unconfirmed save must be checked in Drive.")
        const auth = await selected(c, draft.connectionId); if (!auth.ok) return auth.reply
        const target = draft.savedFileId ?? draft.fileId
        const meta = await metadata(c, auth.deps, target); if (!meta.ok) return meta.reply
        const copy = draft.saveAsCopy && !draft.savedFileId
        if (!copy && (meta.file.version !== draft.revision || meta.file.mimeType !== draft.mimeType || !meta.file.capabilities?.canEdit)) return failure(c, "This file changed in Drive or is read-only. Keep this tab open and download a copy from the editor, then reopen the Drive file.")
        const bytes = new Uint8Array(Buffer.from(draft.draft ?? draft.source, "base64")); await validateOfficePackage(bytes, draft.fileType)
        let body: BodyInit = bytes.buffer; let contentType = draft.mimeType
        const url = new URL(`/upload/drive/v3/files${copy ? "" : `/${target}`}`, env.googleApiBaseUrl ?? "https://www.googleapis.com")
        url.searchParams.set("uploadType", copy ? "multipart" : "media"); url.searchParams.set("fields", "id,name,mimeType,version"); url.searchParams.set("supportsAllDrives", "true")
        if (copy) {
          const boundary = `office_${randomUUID()}`; contentType = `multipart/related; boundary=${boundary}`
          body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: draft.name, mimeType: draft.mimeType })}\r\n--${boundary}\r\nContent-Type: ${draft.mimeType}\r\n\r\n`, bytes.buffer, `\r\n--${boundary}--\r\n`])
        }
        const binaryDeps = { ...auth.deps, fetch: (request: Parameters<typeof fetch>[0], init?: RequestInit) => { const headers = new Headers(init?.headers); headers.set("content-type", contentType); return auth.deps.fetch(request, { ...init, headers, signal: AbortSignal.timeout(20_000) }) } }
        // Retaining recovery bytes must not extend admission of a Drive write,
        // including when metadata reads or shared storage were slow at expiry.
        if (!officeSessionActive(draft)) return failure(c, "This editing session expired. Download the last received copy before recovery expires.")
        // Persist uncertainty before writing: a lost response must never trigger an automatic duplicate/overwrite.
        draft.uncertain = true; await store.put(draft)
        if (!officeSessionActive(draft)) return failure(c, "This editing session expired before Drive was contacted. Download the last received copy.")
        const result = await requestGoogleAction(c, binaryDeps, [scope], url, { method: copy ? "POST" : "PATCH", body, ...(meta.etag && !copy ? { headers: { "if-match": meta.etag } } : {}) })
        if (!result.ok) return result.reply
        const saved = z.object({ id: documentIdSchema, version: z.string() }).parse(await readGoogleActionJson(result.response))
        if (!copy && saved.id !== target) throw new Error("The save response could not be verified. Check the file in Drive before reopening it.")
        draft.savedFileId = saved.id; draft.revision = saved.version; draft.uncertain = false
        await store.put(draft)
        return c.json({ fileId: saved.id })
      }))
    } catch (error) { return failure(c, error instanceof Error ? error.message : "The save was not confirmed. Check Drive before trying again.") }
  })

  // Deliberately smaller than an engine export: exact bytes of the last received
  // snapshot, with fresh identity, membership, connector and file authorization.
  const downloadDescription: DescribeRouteOptions & { "x-mcp": false } = { operationId: "downloadGoogleDriveOfficeSnapshot", summary: "Download the last received Office snapshot", description: "Exact bytes already received by the service, not a live engine export. Requires the session owner's current membership, feature, connector and file authorization. Available for fifteen minutes after editing expiry; never renews WOPI or writes Drive.", tags: ["Documents"], "x-mcp": false, responses: { 200: { description: "Last received Office snapshot.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, 409: jsonResponse("Recovery is unavailable or expired.", failureSchema) } }
  app.get(`${ROOT}/:sessionId/download`, describeRoute(downloadDescription), orgMemberRoute(), guard, paramValidator(sessionParams), async c => {
    try {
      const input = c.req.valid("param"); const draft = await owned(c, input.sessionId, input.fileId)
      const auth = await selected(c, draft.connectionId); if (!auth.ok) return auth.reply
      const check = await metadata(c, auth.deps, draft.savedFileId ?? draft.fileId); if (!check.ok) return check.reply
      const bytes = new Uint8Array(Buffer.from(draft.draft ?? draft.source, "base64"))
      return new Response(bytes.buffer, { headers: { "content-type": draft.mimeType, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(draft.name)}`, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "x-document-draft-version": String(draft.draftVersion) } })
    } catch { return failure(c, "This recovery copy is unavailable or expired. Check the saved file in Drive.") }
  })

  app.post(`${ROOT}/:sessionId/close`, description("closeGoogleDriveOfficeEditor", "Discard the temporary Office session without changing Drive", z.object({ ok: z.literal(true) })), orgMemberRoute(), guard, paramValidator(sessionParams), async c => {
    if (!store) return failure(c, "The document editor is unavailable.")
    try {
      const input = c.req.valid("param"); const draft = await owned(c, input.sessionId, input.fileId)
      await store.lock(draft.id, () => store.remove(draft))
      return c.json({ ok: true })
    } catch { return failure(c, "This editing session is already closed or expired.") }
  })

  const wopiDraft = async (c: Parameters<MiddlewareHandler<{ Variables: OrgRouteVariables }>>[0], write = false) => {
    const id = z.string().uuid().parse(c.req.param("sessionId")); const draft = await store?.get(id)
    const bearer = c.req.header("authorization")?.replace(/^Bearer /i, "")
    if (!draft || !officeSessionActive(draft) || !service || !officeTicketMatches(draft, c.req.query("access_token") ?? bearer) || !await serviceAuthorized(c, draft)) return null
    if (write) {
      const auth = await selected(c, draft.connectionId)
      if (!draft.canEdit || !auth.ok || !canWriteDriveDocument(auth.token.account.scopes, auth.token.enabledScopes)) return null
      const meta = await metadata(c, auth.deps, draft.savedFileId ?? draft.fileId)
      if (!meta.ok || ((!draft.saveAsCopy || draft.savedFileId) && !meta.file.capabilities?.canEdit)) return null
    }
    const blocked = await beginAuditRequest(c); if (blocked) throw blocked
    c.header("cache-control", "no-store"); c.header("x-content-type-options", "nosniff")
    return draft
  }
  // Storage/lock failures are temporary, not revoked credentials. A 403 makes
  // the engine invalidate a still-valid session and can strand unsaved edits.
  const wopiFailure = (c: GoogleContext, error: unknown) => error instanceof Response ? error : c.json({ error: "document_service_unavailable" }, 503)
  const lockConflict = (c: GoogleContext, value: string) => c.json({ error: "lock_mismatch" }, 409, { "X-WOPI-Lock": value })

  app.get(SERVICE, description("getOfficeFileInfo", "Read metadata for one temporary editor session", z.unknown(), []), tokenRoute, async c => {
    try {
      const draft = await wopiDraft(c)
      if (!draft || !service) return c.json({ error: "not_found" }, 403)
      return c.json(service.fileInfo(draft, Buffer.byteLength(draft.draft ?? draft.source, "base64")))
    } catch (error) { return wopiFailure(c, error) }
  })
  app.get(`${SERVICE}/contents`, description("getOfficeFileContents", "Read one temporary editor file", z.unknown(), []), tokenRoute, async c => {
    try {
      const draft = await wopiDraft(c)
      if (!draft) return c.json({ error: "not_found" }, 403)
      return new Response(new Uint8Array(Buffer.from(draft.draft ?? draft.source, "base64")).buffer, { headers: { "content-type": draft.mimeType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "X-WOPI-ItemVersion": String(draft.draftVersion) } })
    } catch (error) { return wopiFailure(c, error) }
  })
  app.post(`${SERVICE}/contents`, description("putOfficeFileContents", "Stage editor changes without writing to Drive", z.object({ LastModifiedTime: z.string() }), []), tokenRoute, bodyLimit({ maxSize: 12 * 1024 * 1024 }), async c => {
    if (!store) return c.json({ error: "not_found" }, 403)
    try {
      const draft = await wopiDraft(c, true)
      if (!draft) return c.json({ error: "not_found" }, 403)
      const bytes = await officeBytes(new Response(c.req.raw.body))
      try { await validateOfficePackage(bytes, draft.fileType) }
      catch { return c.json({ error: "invalid_document_package" }, 400) }
      return await store.lock(draft.id, async () => {
        const current = await store.get(draft.id); if (!current || !officeSessionActive(current)) return c.json({ error: "expired" }, 403)
        const lock = current.wopiLock && current.wopiLock.expiresAt > Date.now() ? current.wopiLock.value : ""
        if (lock && lock !== c.req.header("x-wopi-lock")) return lockConflict(c, lock)
        current.draft = Buffer.from(bytes).toString("base64"); current.draftVersion++
        const requestId = z.string().uuid().safeParse(c.req.header("x-cool-wopi-extendeddata") ?? c.req.header("x-lool-wopi-extendeddata"))
        current.saveRequestId = requestId.success ? requestId.data : undefined
        await store.put(current)
        return c.json({ LastModifiedTime: new Date().toISOString() }, 200, { "X-WOPI-ItemVersion": String(current.draftVersion) })
      })
    } catch (error) { return wopiFailure(c, error) }
  })
  app.post(SERVICE, description("lockOfficeFile", "Manage a temporary editor session lock", z.object({ ok: z.boolean() }), []), tokenRoute, bodyLimit({ maxSize: 1024 }), async c => {
    if (!store) return c.json({ error: "not_found" }, 403)
    try {
      const draft = await wopiDraft(c, true)
      if (!draft) return c.json({ error: "not_found" }, 403)
      const action = c.req.header("x-wopi-override"); const requested = c.req.header("x-wopi-lock") ?? ""
      if (!["LOCK", "UNLOCK", "REFRESH_LOCK", "GET_LOCK"].includes(action ?? "") || requested.length > 1024) return c.json({ error: "unsupported_operation" }, 400)
      return await store.lock(draft.id, async () => {
        const current = await store.get(draft.id); if (!current || !officeSessionActive(current)) return c.json({ error: "expired" }, 403)
        const lock = current.wopiLock && current.wopiLock.expiresAt > Date.now() ? current.wopiLock.value : ""
        if (action === "GET_LOCK") return c.json({ ok: true }, 200, { "X-WOPI-Lock": lock })
        const previous = c.req.header("x-wopi-oldlock") ?? requested
        if (!requested || (lock && lock !== previous) || (action !== "LOCK" && lock !== requested)) return lockConflict(c, lock)
        current.wopiLock = action === "UNLOCK" ? undefined : { value: requested, expiresAt: Date.now() + 30 * 60 * 1000 }
        await store.put(current)
        return c.json({ ok: true })
      })
    } catch (error) { return wopiFailure(c, error) }
  })
  routeApp.route("/", app)
}
