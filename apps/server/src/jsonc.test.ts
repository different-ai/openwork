import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedRegularTextFile, updateJsoncPath } from "./jsonc.js";

describe("readBoundedRegularTextFile", () => {
  test("rejects files that exceed the byte budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-bounded-read-"));
    try {
      const file = join(dir, "config.jsonc");
      await writeFile(file, "x".repeat(65), "utf8");

      await expect(readBoundedRegularTextFile(file, { maxBytes: 64 })).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects non-regular paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-bounded-read-"));
    try {
      const directoryPath = join(dir, "config.jsonc");
      await mkdir(directoryPath);

      await expect(readBoundedRegularTextFile(directoryPath, { maxBytes: 64 })).rejects.toMatchObject({
        code: "NOT_REGULAR_FILE",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a FIFO without waiting for a writer", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "openwork-bounded-read-"));
    try {
      const fifo = join(dir, "config.jsonc");
      const created = spawnSync("mkfifo", [fifo]);
      expect(created.error).toBeUndefined();
      expect(created.status).toBe(0);

      await expect(readBoundedRegularTextFile(fifo, { maxBytes: 64 })).rejects.toMatchObject({
        code: "NOT_REGULAR_FILE",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honors an already-aborted diagnostics deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-bounded-read-"));
    try {
      const file = join(dir, "config.jsonc");
      await writeFile(file, "{}", "utf8");
      const controller = new AbortController();
      controller.abort(new Error("diagnostics deadline exceeded"));

      await expect(readBoundedRegularTextFile(file, {
        maxBytes: 64,
        signal: controller.signal,
      })).rejects.toThrow("diagnostics deadline exceeded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("updateJsoncPath", () => {
  test("patches nested values without replacing sibling config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-jsonc-"));
    const file = join(dir, "opencode.jsonc");
    await writeFile(
      file,
      `{
  // keep this permission comment
  "permission": {
    "clipboard": "ask",
    "external_directory": {
      "/old/*": "allow"
    }
  },
  "model": "openai/gpt-5"
}
`,
      "utf8",
    );

    await updateJsoncPath(file, ["permission", "external_directory"], {
      "/next/*": "allow",
    });

    const next = await readFile(file, "utf8");
    expect(next).toContain('"clipboard": "ask"');
    expect(next).toContain('"model": "openai/gpt-5"');
    expect(next).toContain('"/next/*": "allow"');
    expect(next).not.toContain('"/old/*": "allow"');
  });

  test("removes parent object when nested property was the only entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-jsonc-"));
    const file = join(dir, "opencode.jsonc");
    await writeFile(
      file,
      `{
  "permission": {
    "external_directory": {
      "/old/*": "allow"
    }
  }
}
`,
      "utf8",
    );

    await updateJsoncPath(file, ["permission"], undefined);

    const next = await readFile(file, "utf8");
    expect(next).not.toContain('"permission"');
  });

  test("adds a nested provider without replacing existing providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openwork-jsonc-"));
    const file = join(dir, "opencode.jsonc");
    await writeFile(
      file,
      `{
  "provider": {
    "openai": {
      "models": {
        "gpt-5": {}
      }
    }
  }
}
`,
      "utf8",
    );

    await updateJsoncPath(file, ["provider", "ollama"], {
      npm: "@ai-sdk/openai-compatible",
      name: "Ollama (local)",
      options: { baseURL: "http://localhost:11434/v1" },
      models: { llama2: { name: "Llama 2" } },
    });

    const next = await readFile(file, "utf8");
    expect(next).toContain('"openai"');
    expect(next).toContain('"ollama"');
    expect(next).toContain('"baseURL": "http://localhost:11434/v1"');
  });
});
