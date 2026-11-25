// Published-object fixture for the admin release proof; never loaded by production.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const origin = "https://managed-fixture.s3.us-east-1.amazonaws.com";
const hash = value => createHash("sha256").update(value).digest("hex");
const repositories = {
  den_api: "openwork-den-api", den_web: "openwork-den-web", headless_runner: "openwork-headless-runner",
  workbot: "openwork-workbot", ai_gateway: "openwork-inference",
};

function archive(files) {
  const parts = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function objects(version) {
  const files = Object.fromEntries([
    "infra/managed-deployments/aws/terraform/main.tf",
    "infra/managed-deployments/aws/terraform/assistants.tf",
    "infra/managed-deployments/aws/terraform/runtime-profile.tf",
    "infra/managed-deployments/aws/runner/runner.py",
    "infra/managed-deployments/aws/health/health_agent.py",
    "infra/managed-deployments/aws/health/assistant_health_agent.py",
    "infra/terraform/modules/openwork-aws-ecs/main.tf",
  ].map(name => [name, `# Deterministic ${version} artifact fixture. Never executed.\n`]));
  const release = {
    provider: "aws", version, protocolVersion: 1,
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])),
    images: Object.fromEntries(Object.entries(repositories).map(([kind, repository]) => [kind, `ghcr.io/different-ai/${repository}@sha256:${"a".repeat(64)}`])),
  };
  const bundle = archive({ ...files, "release.json": JSON.stringify(release) });
  const template = Buffer.from(JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Description: "Non-executable published-artifact fixture", Resources: {} }));
  const manifest = Buffer.from(JSON.stringify({ provider: "aws", version, protocolVersion: 1, bundleSha256: version === "1.2.4" ? "0".repeat(64) : hash(bundle), templateSha256: hash(template) }));
  return { "manifest.json": manifest, "bundle.tar.gz": bundle, "cloudformation.json": template };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin === origin) {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    console.info("Managed installer fixture:", JSON.stringify({ method, path: url.pathname, immutable: url.searchParams.has("versionId") }));
    if (!["GET", "HEAD"].includes(method)) throw new Error("The published-object fixture accepts reads only");
    const match = /^\/releases\/aws\/(1\.2\.[234])\/(manifest\.json|bundle\.tar\.gz|cloudformation\.json)$/.exec(url.pathname);
    if (url.pathname === "/releases/aws/1.2.5/manifest.json") return new Response("Private storage diagnostic: never show this provider body", { status: 403 });
    if (!match) return new Response(null, { status: 404 });
    const [, version, file] = match;
    const versionId = `fixture-${version}-${file}`;
    if (url.search && url.searchParams.get("versionId") !== versionId) return new Response(null, { status: 404 });
    const bytes = objects(version)[file];
    return new Response(method === "HEAD" ? null : bytes, { headers: { "content-length": String(bytes.length), "x-amz-version-id": versionId } });
  }
  if (url.href === "https://api.github.com/repos/different-ai/openwork/releases/latest") {
    if (new Headers(init?.headers).get("accept") !== "application/vnd.github+json") return Response.json({ message: "Unsupported media type" }, { status: 415 });
    return Response.json({ tag_name: "v1.2.3", draft: false, prerelease: false, html_url: "https://github.com/different-ai/openwork/releases/tag/v1.2.3" });
  }
  return originalFetch(input, init);
}, originalFetch);
