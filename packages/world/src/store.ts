import { chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const SAFE_WORLD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertWorldName(name: string): void {
  if (!SAFE_WORLD_NAME.test(name)) {
    throw new Error("World names must use only letters, numbers, dots, underscores, and hyphens.");
  }
}

function worldFileName(name: string): string {
  assertWorldName(name);
  return `${name}.json`;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

export class WorldStateStore {
  readonly directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("World state directories must be absolute paths.");
    this.directory = directory;
  }

  path(name: string): string {
    return join(this.directory, worldFileName(name));
  }

  resolve(nameOrPath: string): string {
    return nameOrPath.endsWith(".json") || nameOrPath.includes("/") || nameOrPath.includes("\\")
      ? nameOrPath
      : this.path(nameOrPath);
  }

  async save(name: string, jsonText: string): Promise<string> {
    const path = this.path(name);
    await mkdir(this.directory, { recursive: true });
    await writeFile(path, jsonText.endsWith("\n") ? jsonText : `${jsonText}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    return path;
  }

  read(nameOrPath: string): Promise<string> {
    return readFile(this.resolve(nameOrPath), "utf8");
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.directory))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(this.directory, name));
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async forget(name: string): Promise<boolean> {
    try {
      await unlink(this.path(name));
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }
}
