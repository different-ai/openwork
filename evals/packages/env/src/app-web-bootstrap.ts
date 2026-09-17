import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function seedSyntheticPreactivatedDen(fixtureRoot: string, origin?: string): Promise<Record<string, string>> {
  if (origin === undefined) return {};
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) {
    throw new Error("Preactivated synthetic Den requires an exact HTTPS origin");
  }
  const path = join(fixtureRoot, "config", "openwork", "desktop-bootstrap.json");
  await writeFile(path, JSON.stringify({
    enterpriseActivation: { activatedAt: new Date().toISOString(), denBaseUrl: origin },
  }), { mode: 0o600, flag: "wx" });
  return { OPENWORK_DESKTOP_BOOTSTRAP_PATH: path };
}
