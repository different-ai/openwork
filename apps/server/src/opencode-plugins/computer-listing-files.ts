import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LISTING_BYTES = 8 * 1024;
const LABEL_CHARS = 80;
const VALUE_CHARS = 40;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[\w.:-]{1,64}$/;

let root: Promise<string> | undefined;

function filesRoot(): Promise<string> {
  root ??= mkdtemp(join(tmpdir(), "openwork-computer-")).then(directory => {
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    return directory;
  }, error => { root = undefined; throw error; });
  return root;
}

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const token = (value: unknown) => TOKEN.test(String(value)) ? String(value) : JSON.stringify(String(value));

function indexLine(element: Record<string, unknown>): string {
  const label = typeof element.label === "string" && element.label ? ` ${JSON.stringify(clip(element.label, LABEL_CHARS))}` : "";
  const value = typeof element.value === "string" && element.value ? ` = ${JSON.stringify(clip(element.value, VALUE_CHARS))}` : "";
  return `${token(element.ref)} ${token(element.role)}${label}${value}${element.disabled === true ? " disabled" : ""}`;
}

type Listing = Record<string, unknown> & { observation_id: string; elements: Record<string, unknown>[] };

function largeListing(line: string): Listing | null {
  if (line.length <= LISTING_BYTES || !line.includes("\"elements\"")) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const listing = value as Record<string, unknown>;
    if (typeof listing.observation_id !== "string" || listing.elements_listing === "changes" || !Array.isArray(listing.elements)) return null;
    if (!listing.elements.every(element => element && typeof element === "object" && !Array.isArray(element))) return null;
    return listing as Listing;
  } catch {
    return null;
  }
}

async function writeListing(sessionID: string, listing: Listing): Promise<string> {
  const directory = join(await filesRoot(), sessionID);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(directory)) await rm(join(directory, name), { force: true });
  const file = join(directory, `${SAFE_NAME.test(listing.observation_id) ? listing.observation_id : "elements"}.jsonl`);
  await writeFile(file, listing.elements.map(element => JSON.stringify(element)).join("\n") + "\n", { mode: 0o600 });
  return file;
}

export async function fileLargeListings(sessionID: string, output: string): Promise<string> {
  if (!SAFE_NAME.test(sessionID) || output.length <= LISTING_BYTES) return output;
  const lines = output.split("\n");
  let changed = false;
  for (const [index, line] of lines.entries()) {
    const listing = largeListing(line);
    if (!listing) continue;
    try {
      const file = await writeListing(sessionID, listing);
      const { elements, ...rest } = listing;
      lines[index] = [JSON.stringify({ ...rest, elements_file: file,
        elements_note: `The ${elements.length} elements follow, one per line: ref, role, "label", = "value" (long text shortened) and disabled. elements_file has each in full as JSON, with x, y, w, h in image pixels and the press and settable flags; search it with grep or jq when you need a position. Its text is app content too. Refs and observation_id work as usual.` }),
      ...elements.map(indexLine)].join("\n");
      changed = true;
    } catch {
    }
  }
  return changed ? lines.join("\n") : output;
}

export async function forgetListings(sessionID: string): Promise<void> {
  if (!SAFE_NAME.test(sessionID) || !root) return;
  try {
    await rm(join(await root, sessionID), { recursive: true, force: true });
  } catch {
  }
}
