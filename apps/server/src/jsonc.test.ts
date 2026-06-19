import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateJsoncPath } from "./jsonc.js";

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
