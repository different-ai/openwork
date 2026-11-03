import { afterEach, describe, expect, spyOn, test } from "bun:test"

import { createOpenworkServerClient } from "../src/app/lib/openwork-server"
import { attachmentNoteText, composeV2Prompt, splitV2Prompt } from "../src/app/lib/v2-prompt-context"

const INBOX_PATH = "chat-attachments/s1/a-result.mp4"
const MEDIA_HINT = "command-line tools such as ffmpeg"

function fileOfSize(size: number) {
  const file = new File(["x"], "result.mp4", { type: "video/mp4" })
  Object.defineProperty(file, "size", { value: size })
  return file
}

function uploadClient() {
  return createOpenworkServerClient({ baseUrl: "http://127.0.0.1:1", token: "token" })
}

describe("uploadInbox", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  test("sends the file itself so it never has to fit in memory", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, path: INBOX_PATH, bytes: 1 }))
    spies.push(fetchSpy)
    const file = new File(["x"], "result.mp4", { type: "video/mp4" })

    const result = await uploadClient().uploadInbox("w1", file, { path: INBOX_PATH })

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`http://127.0.0.1:1/workspace/w1/inbox?path=${encodeURIComponent(INBOX_PATH)}`)
    expect(init.body).toBe(file)
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/octet-stream")
    expect(result).toEqual({ ok: true, path: INBOX_PATH, bytes: 1 })
  })

  test("falls back to multipart for a worker that has not updated", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ code: "invalid_payload", message: "Expected multipart/form-data" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ ok: true, path: INBOX_PATH, bytes: 1 }))
    spies.push(fetchSpy)

    await uploadClient().uploadInbox("w1", new File(["x"], "result.mp4"), { path: INBOX_PATH })

    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect(url).toBe("http://127.0.0.1:1/workspace/w1/inbox")
    expect((init.body as FormData).get("path")).toBe(INBOX_PATH)
    expect((init.body as FormData).get("file")).toBeInstanceOf(File)
  })

  test("gives a large file longer than a minute to arrive", async () => {
    spies.push(spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, path: INBOX_PATH, bytes: 1 })))
    const timeoutSpy = spyOn(globalThis, "setTimeout")
    spies.push(timeoutSpy)

    await uploadClient().uploadInbox("w1", fileOfSize(300_000_000), { path: INBOX_PATH })
    await uploadClient().uploadInbox("w1", fileOfSize(1_000), { path: INBOX_PATH })

    const [large, small] = timeoutSpy.mock.calls.map((call) => Number(call[1]))
    expect(large).toBeGreaterThan(15 * 60_000)
    expect(small).toBe(60_000)
  })
})

describe("attachment note", () => {
  const video = { filename: "result.mp4", workspacePath: ".opencode/openwork/inbox/result.mp4", url: "file:///w/result.mp4" }

  test("points the model at command-line tools only when a file cannot be viewed", () => {
    expect(attachmentNoteText([video], { hasBinaryFiles: true })).toContain(MEDIA_HINT)
    expect(attachmentNoteText([video])).not.toContain(MEDIA_HINT)
  })

  test("stays hidden from the person, in new and older messages", () => {
    for (const note of [attachmentNoteText([video], { hasBinaryFiles: true }), attachmentNoteText([video])]) {
      for (const stored of [composeV2Prompt("edit this video", [note]), `edit this video\n${note}`]) {
        const split = splitV2Prompt(stored)
        expect(split.segments.map((segment) => segment.kind === "text" ? segment.text.trim() : segment.kind)).toEqual(["edit this video"])
        expect(split.attachments.map((item) => item.filename)).toEqual(["result.mp4"])
      }
    }
  })
})
