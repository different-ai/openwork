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
    expect(content[0].text).toContain("bytes delivered as image content")
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
    expect(textPart.text).toContain("bytes delivered as image content")
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

test("buildRestToolContent leaves non-image binary payloads unchanged", async () => {
  const payload = { file: { dataBase64: "AAAA", mimeType: "application/pdf" } }
  expect(await buildRestToolContent(payload)).toEqual([{
    type: "text",
    text: JSON.stringify(payload, null, 2),
  }])
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
