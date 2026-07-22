const BRAND_ICON_MAX_BYTES = 2 * 1024 * 1024
const BRAND_ICON_FETCH_TIMEOUT_MS = 10_000
const BRAND_ICON_MIN_DIMENSION_PX = 64
const BRAND_ICON_MAX_ASPECT_RATIO = 1.5

// Keep in sync with apps/desktop/electron/main.mjs so logo CDNs that expect a
// browser request behave the same at save time and apply time.
export const BRAND_ICON_FETCH_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

type BrandIconValidationFailure = {
  ok: false
  reason: string
  message: string
}

export type BrandIconValidationResult = { ok: true } | BrandIconValidationFailure

type ImageDimensions = {
  width: number
  height: number
}

function failure(reason: string, message: string): BrandIconValidationFailure {
  return { ok: false, reason, message }
}

function parseHttpUrl(value: string) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function isPng(bytes: Uint8Array) {
  return bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
}

function isJpeg(bytes: Uint8Array) {
  return bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
}

function hasPngIhdr(bytes: Uint8Array) {
  return bytes.byteLength >= 24
    && bytes[12] === 0x49
    && bytes[13] === 0x48
    && bytes[14] === 0x44
    && bytes[15] === 0x52
}

function parsePngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!isPng(bytes) || !hasPngIhdr(bytes)) {
    return null
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}

function isStandaloneJpegMarker(marker: number) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
}

function isJpegStartOfFrame(marker: number) {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf)
}

function parseJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!isJpeg(bytes)) {
    return null
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2

  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) {
      offset += 1
    }

    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1
    }

    if (offset >= bytes.byteLength) {
      return null
    }

    const marker = bytes[offset]
    offset += 1

    if (marker === 0xd9 || marker === 0xda) {
      return null
    }

    if (isStandaloneJpegMarker(marker)) {
      continue
    }

    if (offset + 2 > bytes.byteLength) {
      return null
    }

    const segmentLength = view.getUint16(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      return null
    }

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) {
        return null
      }

      const height = view.getUint16(offset + 3)
      const width = view.getUint16(offset + 5)
      if (width <= 0 || height <= 0) {
        return null
      }
      return { width, height }
    }

    offset += segmentLength
  }

  return null
}

function parseSupportedImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return parsePngDimensions(bytes) ?? parseJpegDimensions(bytes)
}

async function readBodyWithLimit(response: Response): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > BRAND_ICON_MAX_BYTES ? { ok: false } : { ok: true, bytes }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  while (true) {
    const result = await reader.read()
    if (result.done) {
      break
    }

    const chunk = result.value
    byteLength += chunk.byteLength
    if (byteLength > BRAND_ICON_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      return { ok: false }
    }
    chunks.push(chunk)
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}

export async function validateBrandIconUrl(url: string): Promise<BrandIconValidationResult> {
  const parsed = parseHttpUrl(url)
  if (!parsed) {
    return failure("invalid-url", "Use an http or https URL for the brand icon.")
  }

  try {
    const response = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(BRAND_ICON_FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": BRAND_ICON_FETCH_USER_AGENT,
        accept: "image/*,*/*",
      },
    })

    if (!response.ok) {
      return failure("fetch-failed", `Couldn't load that image (the server returned ${response.status}).`)
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.toLowerCase().startsWith("image/")) {
      return failure("not-an-image", "That link didn't return an image — it may redirect to a web page instead of the file (some logo CDNs block hotlinking). Use a direct PNG URL.")
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0")
    if (Number.isFinite(contentLength) && contentLength > BRAND_ICON_MAX_BYTES) {
      return failure("too-large", "That image is too large. Use an image under 2 MB.")
    }

    const body = await readBodyWithLimit(response)
    if (!body.ok) {
      return failure("too-large", "That image is too large. Use an image under 2 MB.")
    }

    const dimensions = parseSupportedImageDimensions(body.bytes)
    if (!dimensions) {
      return failure("unsupported-format", "That image format is not supported. Use a direct PNG or JPEG image URL.")
    }

    if (dimensions.width < BRAND_ICON_MIN_DIMENSION_PX || dimensions.height < BRAND_ICON_MIN_DIMENSION_PX) {
      return failure("too-small", "That image is too small. Use an image at least 64×64 pixels.")
    }

    const aspectRatio = dimensions.width / dimensions.height
    if (aspectRatio < 1 / BRAND_ICON_MAX_ASPECT_RATIO || aspectRatio > BRAND_ICON_MAX_ASPECT_RATIO) {
      return failure("invalid-aspect", "Use a roughly square image for the brand icon.")
    }

    return { ok: true }
  } catch {
    return failure("fetch-failed", "Couldn't reach that image URL.")
  }
}
