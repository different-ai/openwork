import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NEW_CONFIG_DIR = ".openwork";
const LEGACY_CONFIG_DIR = ".opencode";
const CONFIG_FILENAME = "openwork.json";

export type MigrationResult =
  | { status: "migrated"; from: string; to: string }
  | { status: "already_migrated" }
  | { status: "no_legacy_config" }
  | { status: "skipped_newer_target"; reason: string }
  | { status: "error"; reason: string };

export function migrateOpenworkConfig(workspaceRoot: string): MigrationResult {
  const legacyPath = join(workspaceRoot, LEGACY_CONFIG_DIR, CONFIG_FILENAME);
  const newPath = join(workspaceRoot, NEW_CONFIG_DIR, CONFIG_FILENAME);

  if (!existsSync(legacyPath)) {
    return { status: "no_legacy_config" };
  }

  try {
    if (existsSync(newPath)) {
      const legacyContent = readFileSync(legacyPath, "utf8");
      const newContent = readFileSync(newPath, "utf8");

      if (legacyContent === newContent) {
        return { status: "already_migrated" };
      }

      return {
        status: "skipped_newer_target",
        reason: "both .opencode/openwork.json and .openwork/openwork.json exist with different content, keeping .openwork/ version",
      };
    }

    mkdirSync(dirname(newPath), { recursive: true });
    copyFileSync(legacyPath, newPath);

    return { status: "migrated", from: legacyPath, to: newPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", reason: `filesystem error during migration: ${message}` };
  }
}
