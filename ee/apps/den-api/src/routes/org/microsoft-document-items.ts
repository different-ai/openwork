import { z } from "zod"
import { documentIdSchema } from "@openwork/documents/model"

export const graphIdSchema = z.string().regex(/^[A-Za-z0-9!._-]{1,256}$/)

/**
 * Documents names a OneDrive item by its drive and item ids together, because shared
 * and recent files live in other people's drives. The pair is base64url so it fits the
 * same opaque file id every Documents route and proxy already accepts.
 */
export function encodeMicrosoftDocumentId(driveId: string, itemId: string): string {
  return Buffer.from(`${driveId}\n${itemId}`, "utf8").toString("base64url")
}

export function decodeMicrosoftDocumentId(fileId: string): { driveId: string; itemId: string } | null {
  const [driveId, itemId, extra] = Buffer.from(fileId, "base64url").toString("utf8").split("\n")
  if (extra !== undefined || !graphIdSchema.safeParse(driveId).success || !graphIdSchema.safeParse(itemId).success) return null
  return { driveId: driveId!, itemId: itemId! }
}

export const graphItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  lastModifiedDateTime: z.string().optional(),
  webUrl: z.string().optional(),
  eTag: z.string().optional(),
  file: z.object({ mimeType: z.string().optional() }).optional(),
  folder: z.object({}).passthrough().optional(),
  parentReference: z.object({ driveId: z.string().optional() }).optional(),
})
export const graphListingSchema = z.object({
  value: z.array(graphItemSchema.extend({ remoteItem: graphItemSchema.optional() })),
  "@odata.nextLink": z.string().optional(),
})

export const documentItemSchema = z.object({
  id: documentIdSchema,
  name: z.string(),
  mimeType: z.string(),
  kind: z.enum(["folder", "file"]),
  modifiedTime: z.string().nullable(),
  size: z.number().nullable(),
  openUrl: z.string().nullable(),
})
type DocumentItem = z.infer<typeof documentItemSchema>
export const listingResponseSchema = z.object({ files: z.array(documentItemSchema), nextCursor: z.string().nullable() })

/** Only Microsoft's own OneDrive and SharePoint pages become "Open in OneDrive" links. */
export function officeUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return url.protocol === "https:" && (host === "onedrive.live.com" || host === "1drv.ms" || host.endsWith(".sharepoint.com")) ? url.toString() : null
  } catch { return null }
}

/** Shared and recent entries describe the real file in `remoteItem`, in the owner's drive. */
export function microsoftDocumentItem(raw: z.infer<typeof graphListingSchema>["value"][number]): DocumentItem | null {
  const item = raw.remoteItem ?? raw
  const driveId = item.parentReference?.driveId ?? raw.parentReference?.driveId
  if (!driveId || !graphIdSchema.safeParse(item.id).success || !graphIdSchema.safeParse(driveId).success) return null
  const kind = item.folder ? "folder" : item.file ? "file" : null
  if (!kind) return null // OneNote notebooks and other packages have no file content.
  return {
    id: encodeMicrosoftDocumentId(driveId, item.id),
    name: item.name ?? raw.name ?? "Untitled",
    mimeType: kind === "folder" ? "application/vnd.microsoft.folder" : item.file?.mimeType ?? "application/octet-stream",
    kind,
    modifiedTime: item.lastModifiedDateTime ?? raw.lastModifiedDateTime ?? null,
    size: typeof item.size === "number" ? item.size : null,
    openUrl: officeUrl(item.webUrl ?? raw.webUrl),
  }
}
