import { fileSchema, inChat, MAX_UPLOAD_BYTES, type WorkbotFile } from "@openwork-ee/workbot-client"
import { useWorkbotChat, useWorkbotTransport } from "@openwork-ee/workbot-client/hooks"
import { File } from "expo-file-system"
import { useCallback, useRef, useState } from "react"
import { randomBytes } from "../auth/pkce"
import { useSession } from "../auth/session"

/** A file picked on this phone (Photos, Camera or Files), before it is kept by Workbot. */
export type LocalFile = { uri: string; name: string; mimeType: string; size: number }

export type Upload = {
  key: string
  file: LocalFile
  /** Local preview for images, before the upload finishes. */
  previewUri: string | null
  loaded: number
  status: "uploading" | "done" | "failed"
  error: string | null
  saved: WorkbotFile | null
}

const key = () => Array.from(randomBytes(8), (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Files added to the composer. Each uploads right away; the message can be sent while they finish, and waits for
 * them (the web page's tray, with the phone's own pickers).
 */
export function useUploads() {
  const session = useSession()
  const transport = useWorkbotTransport()
  const chat = useWorkbotChat()
  const [uploads, setUploads] = useState<Upload[]>([])
  const waiters = useRef(new Map<string, { promise: Promise<WorkbotFile | null>; controller: AbortController }>())

  const update = (id: string, patch: Partial<Upload>) => setUploads((current) => current.map((upload) => (upload.key === id ? { ...upload, ...patch } : upload)))

  const start = useCallback((file: LocalFile, id: string) => {
    const controller = new AbortController()
    const promise = (async (): Promise<WorkbotFile | null> => {
      if (file.size > MAX_UPLOAD_BYTES) {
        update(id, { status: "failed", error: "The most a file can be is 100 MB." })
        return null
      }
      try {
        const path = inChat(`/v1/workbot/files?${new URLSearchParams({ name: file.name || "file", timeZone: transport.timeZone() })}`, chat)
        const result = await new File(file.uri).upload(session.url(path), {
          httpMethod: "POST",
          headers: { ...(await session.authHeaders()), "content-type": file.mimeType || "application/octet-stream", accept: "application/json" },
          mimeType: file.mimeType || "application/octet-stream",
          onProgress: ({ bytesSent }) => update(id, { loaded: bytesSent }),
          signal: controller.signal,
        })
        let payload: unknown = null
        try {
          payload = JSON.parse(result.body)
        } catch {
          payload = null
        }
        const parsed = fileSchema.safeParse(payload)
        if (result.status === 201 && parsed.success) {
          update(id, { status: "done", saved: parsed.data, loaded: file.size })
          return parsed.data
        }
        update(id, { status: "failed", error: result.status === 409 ? "Files aren't available right now." : result.status === 413 ? "The most a file can be is 100 MB." : "Couldn't upload." })
        return null
      } catch {
        update(id, controller.signal.aborted ? { status: "failed", error: "Canceled." } : { status: "failed", error: "Couldn't upload." })
        return null
      }
    })()
    waiters.current.set(id, { promise, controller })
  }, [chat, session, transport])

  const add = useCallback((files: LocalFile[]) => {
    const added = files.map((file) => ({
      key: key(),
      file,
      previewUri: file.mimeType.startsWith("image/") ? file.uri : null,
      loaded: 0,
      status: "uploading" as const,
      error: null,
      saved: null,
    }))
    setUploads((current) => [...current, ...added])
    for (const upload of added) start(upload.file, upload.key)
  }, [start])

  const retry = (id: string) => {
    const upload = uploads.find((entry) => entry.key === id)
    if (!upload) return
    update(id, { status: "uploading", error: null, loaded: 0 })
    start(upload.file, id)
  }

  const remove = (id: string) => {
    waiters.current.get(id)?.controller.abort()
    waiters.current.delete(id)
    setUploads((current) => current.filter((upload) => upload.key !== id))
  }

  /** Hands the tray's files to a message and clears the tray. Resolves once every upload settled. */
  const take = () => {
    const taken = uploads
    const pending = taken.map((upload) => waiters.current.get(upload.key)?.promise ?? Promise.resolve(upload.saved))
    waiters.current.clear()
    setUploads([])
    return { taken, settled: Promise.all(pending).then((files) => files.flatMap((file) => (file ? [file] : []))) }
  }

  return { uploads, add, retry, remove, take }
}
