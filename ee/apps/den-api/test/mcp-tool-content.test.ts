import { randomBytes } from "node:crypto"
import { expect, test } from "bun:test"
import sharp from "sharp"
import { buildRestToolContent, externalToolContent, isKnownToolContentPart } from "../src/mcp/tool-content.js"

test("buildRestToolContent returns a plain object as one text part", async () => {
  const payload = { ok: true, count: 2 }
  expect(await buildRestToolContent(payload)).toEqual([{
    type: "text",
    text: JSON.stringify(payload, null, 2),
  }])
})

test("buildRestToolContent emits a small image and redacts its base64 from text", async () => {
  const data = (await sharp({
    create: { width: 2, height: 2, channels: 4, background: "red" },
  }).png().toBuffer()).toString("base64")
  const content = await buildRestToolContent({
    ok: true,
    file: { contentBase64: data, mimeType: "image/png", name: "x.png" },
  })

  expect(content).toHaveLength(2)
  expect(content[0]?.type).toBe("text")
  if (content[0]?.type === "text") {
    expect(content[0].text).toContain("binary bytes omitted from model-visible content")
    expect(content[0].text).not.toContain(data)
  }
  expect(content[1]).toEqual({ type: "image", data, mimeType: "image/png" })
})

test("buildRestToolContent downscales large images to bounded JPEG content", async () => {
  const width = 1600
  const height = 1600
  const png = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png().toBuffer()
  expect(png.byteLength).toBeGreaterThan(1024 * 1024)

  const data = png.toString("base64")
  const content = await buildRestToolContent({
    file: { contentBase64: data, mimeType: "image/png" },
  })
  const textPart = content[0]
  const imagePart = content[1]
  expect(textPart?.type).toBe("text")
  if (textPart?.type === "text") {
    expect(textPart.text).toContain("binary bytes omitted from model-visible content")
    expect(textPart.text).not.toContain(data)
  }
  expect(imagePart?.type).toBe("image")
  if (imagePart?.type === "image") {
    expect(imagePart.mimeType).toBe("image/jpeg")
    const metadata = await sharp(Buffer.from(imagePart.data, "base64")).metadata()
    expect(metadata.width).toBeLessThanOrEqual(1568)
    expect(metadata.height).toBeLessThanOrEqual(1568)
  }
})

test("buildRestToolContent omits non-image PDF and Office base64 from model-visible text", async () => {
  const pdfBase64 = randomBytes(96 * 1024).toString("base64")
  const officeBase64 = randomBytes(80 * 1024).toString("base64")
  const content = await buildRestToolContent({
    files: [
      { dataBase64: pdfBase64, mimeType: "application/pdf", name: "report.pdf" },
      { contentBase64: officeBase64, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "brief.docx" },
    ],
  })
  expect(content).toHaveLength(1)
  expect(content[0]?.type).toBe("text")
  if (content[0]?.type === "text") {
    expect(content[0].text).not.toContain(pdfBase64)
    expect(content[0].text).not.toContain(officeBase64)
    expect(content[0].text).toContain('"dataBase64Omitted": true')
    expect(content[0].text).toContain('"contentBase64Omitted": true')
  }
})

test("buildRestToolContent preserves small non-image bytes for existing attachment flows", async () => {
  const dataBase64 = randomBytes(48 * 1024).toString("base64")
  const content = await buildRestToolContent({
    ok: true,
    attachment: { dataBase64, mimeType: "application/pdf", name: "report.pdf" },
  })
  const text = content[0]?.type === "text" ? content[0].text : ""
  expect(text).toContain(dataBase64)
  expect(text).not.toContain("dataBase64Omitted")
})

test("buildRestToolContent bounds nested model-visible text", async () => {
  const content = await buildRestToolContent({ ok: true, message: { body: "x".repeat(25_000) } })
  const text = content[0]?.type === "text" ? content[0].text : ""
  const parsed = JSON.parse(text) as { message: { body: string } }
  expect(parsed.message.body).toHaveLength(20_000)
  expect(parsed.message.body.endsWith("\n[truncated]")).toBe(true)
  expect(text).not.toContain("x".repeat(20_001))
})

test("buildRestToolContent emits images nested inside arrays and objects", async () => {
  const data = (await sharp({
    create: { width: 2, height: 2, channels: 4, background: "blue" },
  }).png().toBuffer()).toString("base64")
  const content = await buildRestToolContent({ results: [{ nested: { contentBase64: data, mimeType: "image/png" } }] })
  expect(content).toHaveLength(2)
  expect(content[0]?.type === "text" ? content[0].text : "").not.toContain(data)
  expect(content[1]).toEqual({ type: "image", data, mimeType: "image/png" })
})

test("buildRestToolContent owns omission metadata and safely serializes __proto__ keys", async () => {
  const dataBase64 = randomBytes(96 * 1024).toString("base64")
  const payload: unknown = JSON.parse(`{"dataBase64":${JSON.stringify(dataBase64)},"dataBase64Omitted":false,"dataBase64Bytes":1,"__proto__":{"polluted":true}}`)
  const content = await buildRestToolContent(payload)
  const text = content[0]?.type === "text" ? content[0].text : ""
  const parsed = JSON.parse(text) as Record<string, unknown>
  expect(parsed.dataBase64Omitted).toBe(true)
  expect(parsed.dataBase64Bytes).toBe(96 * 1024)
  expect(parsed).toHaveProperty("__proto__")
  expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
})

test("buildRestToolContent compacts JSON only after the model-visible result grows beyond 2 KiB", async () => {
  const small = await buildRestToolContent({ ok: true, value: "small" })
  expect(small[0]?.type === "text" ? small[0].text : "").toContain("\n  \"ok\"")

  const large = await buildRestToolContent({ ok: true, body: "x".repeat(3_000) })
  const text = large[0]?.type === "text" ? large[0].text : ""
  expect(text).not.toContain("\n")
  expect(text).toBe(JSON.stringify({ ok: true, body: "x".repeat(3_000) }))
})

test("known content validation and external content passthrough preserve text and images", () => {
  const textResult = { content: [{ type: "text", text: "hello" }] }
  const imageResult = {
    content: [
      { type: "text", text: "preview" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  }
  const unknownResult = { content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] }

  expect(isKnownToolContentPart(textResult.content[0])).toBe(true)
  expect(isKnownToolContentPart(imageResult.content[1])).toBe(true)
  expect(isKnownToolContentPart(unknownResult.content[0])).toBe(false)
  expect(externalToolContent(textResult)).toBe(textResult.content)
  expect(externalToolContent(imageResult)).toBe(imageResult.content)
  expect(externalToolContent(unknownResult)).toEqual([{
    type: "text",
    text: JSON.stringify(unknownResult),
  }])
})
