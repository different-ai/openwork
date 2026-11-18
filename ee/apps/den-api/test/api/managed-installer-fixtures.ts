import { Buffer } from "node:buffer"
import { gzipSync } from "node:zlib"
import { sha256 } from "../../src/managed-deployments/release-verifier.js"

export const source = "https://managed-fixture.s3.us-east-1.amazonaws.com/releases/aws/"
export const gcpSource = "https://storage.googleapis.com/managed-fixture/releases/gcp/"
export function fixtureArtifacts(version = "1.2.3", options: { coreOnly?: boolean, corrupt?: boolean, imageDigest?: string, provider?: "aws" | "gcp" } = {}) {
  const provider = options.provider ?? "aws"
  const images: Record<string, string> = Object.fromEntries(Object.entries({ den_api: "den-api", den_web: "den-web", ...(provider === "aws" && !options.coreOnly ? { headless_runner: "headless-runner", workbot: "workbot", ai_gateway: "inference" } : {}) }).map(([key, suffix]) => [key, `ghcr.io/different-ai/openwork-${suffix}@sha256:${options.imageDigest ?? "a".repeat(64)}`]))
  if (provider === "gcp") images.health = `docker.io/library/python@sha256:${"a".repeat(64)}`
  const module = Buffer.from("resource \"example\" \"fixture\" {}\n")
  const metadata = Buffer.from(JSON.stringify({ provider, version, protocolVersion: 1, files: { "main.tf": sha256(module) }, images }))
  const archive: Buffer[] = []
  for (const [name, body] of [["main.tf", module], ["release.json", metadata]] satisfies [string, Buffer][]) {
    const header = Buffer.alloc(512)
    header.write(name, 0)
    header.write("0000644\0", 100)
    header.write("0000000\0", 108)
    header.write("0000000\0", 116)
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124)
    header.write("00000000000\0", 136)
    header.fill(32, 148, 156)
    header[156] = 48
    header.write("ustar\0", 257)
    header.write("00", 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148)
    archive.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  const bundle = Buffer.from(gzipSync(new Uint8Array(Buffer.concat([...archive, Buffer.alloc(1024)]))))
  const template = Buffer.from("{\"Resources\":{}}")
  const manifest = Buffer.from(JSON.stringify({ provider, version, protocolVersion: 1, bundleSha256: options.corrupt ? "f".repeat(64) : sha256(bundle), templateSha256: sha256(template) }))
  return new Map([["manifest.json", manifest], [provider === "aws" ? "cloudformation.json" : "tutorial.md", template], ["bundle.tar.gz", bundle]])
}

export function fixtureFetch(versions = new Map([["1.2.3", fixtureArtifacts()]]), options: { noVersion?: boolean, changed?: boolean, provider?: "aws" | "gcp" } = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (!url.href.startsWith(options.provider === "gcp" ? gcpSource : source)) throw new Error("Unexpected fixture request")
    if (init?.redirect !== "error" || init?.credentials !== "omit") throw new Error("Unsafe request")
    const [version, name] = url.pathname.split("/").slice(-2)
    const body = version && name ? versions.get(version)?.get(name) : undefined
    if (!body) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(options.changed && url.search ? Buffer.from("changed") : body), { headers: options.noVersion ? {} : options.provider === "gcp" ? { "x-goog-generation": "1234567890" } : { "x-amz-version-id": `fixture-${version}-${name}` } })
  }
}
