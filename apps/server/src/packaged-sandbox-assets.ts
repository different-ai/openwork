import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import imageLock from "./packaged-sandbox-image.json" with { type: "json" };

export type SandboxImageSdk = {
  setDefaultBackend(backend: "local"): void;
  Image: {
    get(reference: string): Promise<{ manifestDigest: string | null }>;
    load(archive: string, options: { tag: string }): Promise<unknown>;
  };
};

export function packagedSandboxResources(): string | undefined {
  if (!process.versions.electron || "defaultApp" in process && process.defaultApp === true) return undefined;
  if (!("resourcesPath" in process) || typeof process.resourcesPath !== "string") throw new Error("Packaged sandbox resources are unavailable.");
  return process.resourcesPath;
}

export async function loadSandboxImageSdk(): Promise<SandboxImageSdk> {
  const require = createRequire(import.meta.url);
  const adapter = require.resolve("@openwork/sandbox-microsandbox");
  const entry = createRequire(adapter).resolve("microsandbox");
  const sdk: SandboxImageSdk = await import(pathToFileURL(entry).href);
  sdk.setDefaultBackend("local");
  return sdk;
}

export function sandboxImagePin(arch: string = process.arch) {
  const manifestDigest = arch === "arm64" ? imageLock.manifests.arm64 : arch === "x64" ? imageLock.manifests.x64 : undefined;
  if (!manifestDigest) throw new Error(`No pinned sandbox guest image for ${arch}.`);
  return { manifestDigest, reference: `${imageLock.repository}@${manifestDigest}` };
}

// SDK caches are per backend/home. Concurrent requests share only the current
// import, not a process-wide success bit that could outlive that cache.
const imports = new Map<string, Promise<void>>();

export async function prepareSandboxGuestImage(sdk: SandboxImageSdk, resourcesPath = packagedSandboxResources(), arch: string = process.arch): Promise<string> {
  const pin = sandboxImagePin(arch);
  if (!resourcesPath) return pin.reference;
  const directory = join(resourcesPath, "sandbox-image");
  const archive = join(directory, "alpine.oci.tar");
  // Check the bundle before looking at the mutable cache. A broken package
  // never passes just because this computer happens to have a warm image.
  const metadata: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (!metadata || typeof metadata !== "object" || !("arch" in metadata) || metadata.arch !== arch
    || !("reference" in metadata) || metadata.reference !== pin.reference
    || !("manifestDigest" in metadata) || metadata.manifestDigest !== pin.manifestDigest
    || !("archiveSha256" in metadata) || typeof metadata.archiveSha256 !== "string") {
    throw new Error("The packaged sandbox guest image manifest does not match its pinned platform image.");
  }
  const archiveSha256 = `sha256:${createHash("sha256").update(await readFile(archive)).digest("hex")}`;
  if (archiveSha256 !== metadata.archiveSha256) throw new Error("The packaged sandbox guest image archive failed integrity verification.");
  sdk.setDefaultBackend("local");
  try {
    const cached = await sdk.Image.get(pin.reference);
    if (cached.manifestDigest !== pin.manifestDigest) throw new Error("The cached sandbox guest image does not match its pinned digest.");
    return pin.reference;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "imageNotFound")) throw error;
  }
  let pending = imports.get(archive);
  if (!pending) {
    pending = sdk.Image.load(archive, { tag: pin.reference }).then(async () => {
      const imported = await sdk.Image.get(pin.reference);
      if (imported.manifestDigest !== pin.manifestDigest) throw new Error("The imported sandbox guest image does not match its pinned digest.");
    });
    imports.set(archive, pending);
    void pending.finally(() => { if (imports.get(archive) === pending) imports.delete(archive); }).catch(() => {});
  }
  await pending;
  return pin.reference;
}
