import { z } from "zod"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { MicrosoftGraphMutationOutcomeUnknownError, MicrosoftGraphRequestError, MicrosoftGraphScopeError, type MicrosoftGraphClient } from "../../capability-sources/microsoft-graph.js"

// Shared by the Microsoft 365 capability routes and their file transfer routes.

export const graphItemIdSchema = z.string().trim().min(1).max(512)
  .refine((value) => value !== "." && value !== ".." && !/[\s/\\?#]/.test(value), "Use a Microsoft Graph item id, not a path or URL.")

export const driveIdSchema = graphItemIdSchema.describe("The file's driveId from a search, folder or link result. Omit for the member's own OneDrive.")

export const driveItemNameSchema = z.string().trim().min(1).max(255)
  .refine((value) => value !== "." && value !== ".." && !/["*:<>?\/\\|\u0000-\u001f]/.test(value) && !value.endsWith("."), "Use one valid OneDrive file or folder name, not a path.")

export const driveItemSchema = z.object({
  id: z.string(),
  driveId: z.string().describe("Pass with id to read, list or save this item. Empty when Microsoft did not say; resolve webUrl with the link capability then."),
  parentId: z.string(),
  siteId: z.string().describe("SharePoint site holding the item, when Microsoft reports one."),
  name: z.string(),
  size: z.number().nullable(),
  modifiedTime: z.string(),
  webUrl: z.string(),
  mimeType: z.string(),
  kind: z.enum(["file", "folder", "unknown"]),
  eTag: z.string(),
}).meta({ ref: "Microsoft365DriveItem" })

export const needsConnectionSchema = z.object({
  error: z.literal("needs_connection"),
  message: z.string(),
}).meta({ ref: "Microsoft365NeedsConnectionError" })

export const upstreamErrorSchema = z.object({
  error: z.literal("microsoft_graph_error"),
  message: z.string(),
  outcome: z.literal("unknown").optional(),
  retryable: z.literal(false).optional(),
}).meta({ ref: "Microsoft365GraphError" })

export type Microsoft365Identity = {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  /**
   * A connection a host or signed link names: an id selects exactly that one
   * and null the default. Omitted, capability calls use the signed header.
   */
  connectionId?: string | null
}

/** A ready Graph client for the calling member, or the reply explaining why there is none. */
export type Microsoft365Access = (input: Microsoft365Identity & { features: readonly string[]; label: string }) => Promise<
  | { ok: true; graph: (options?: { signal?: AbortSignal; timeoutMs?: number }) => MicrosoftGraphClient }
  | { ok: false; status: 401 | 403 | 409 | 502; body: { error: string; message: string } }
>

/** 409 for a drive the connection may not reach (an admin can enable the permission); otherwise Graph failed (502). */
export function graphErrorStatus(error: unknown): 409 | 502 {
  return error instanceof MicrosoftGraphScopeError ? 409 : 502
}

export function graphError(error: unknown): { error: "microsoft_graph_error" | "needs_connection"; message: string; outcome?: "unknown"; retryable?: false } {
  if (error instanceof MicrosoftGraphScopeError) {
    return { error: "needs_connection", message: error.message }
  }
  if (error instanceof MicrosoftGraphMutationOutcomeUnknownError) {
    return { error: "microsoft_graph_error", message: error.message, outcome: "unknown", retryable: false }
  }
  if (error instanceof MicrosoftGraphRequestError) {
    return { error: "microsoft_graph_error", message: error.message }
  }
  return {
    error: "microsoft_graph_error",
    message: error instanceof Error ? error.message : "Microsoft Graph request failed.",
  }
}
