import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { revealItemInDir } from "./reveal-item-in-dir.mjs";

describe("revealItemInDir", () => {
  it("reveals an existing file off Windows", async () => {
    let revealedPath = "";
    let openPathCalled = false;

    const result = await revealItemInDir("/workspace/skill/SKILL.md", {
      existsSync: (target) => target === "/workspace/skill/SKILL.md",
      openPath: async () => {
        openPathCalled = true;
        return "";
      },
      platform: "darwin",
      showItemInFolder: (target) => {
        revealedPath = target;
      },
    });

    assert.equal(result, undefined);
    assert.equal(revealedPath, "/workspace/skill/SKILL.md");
    assert.equal(openPathCalled, false);
  });

  it("opens the parent directory for a missing file with an existing parent", async () => {
    let openedPath = "";
    let revealCalled = false;

    const result = await revealItemInDir("/workspace/skill/MISSING.md", {
      existsSync: (target) => target === "/workspace/skill",
      openPath: async (target) => {
        openedPath = target;
        return "";
      },
      platform: "darwin",
      showItemInFolder: () => {
        revealCalled = true;
      },
    });

    assert.equal(result, undefined);
    assert.equal(openedPath, "/workspace/skill");
    assert.equal(revealCalled, false);
  });

  it("reports an error when neither the file nor parent exists", async () => {
    let openPathCalled = false;
    let revealCalled = false;

    const result = await revealItemInDir("/workspace/skill/MISSING.md", {
      existsSync: () => false,
      openPath: async () => {
        openPathCalled = true;
        return "";
      },
      platform: "darwin",
      showItemInFolder: () => {
        revealCalled = true;
      },
    });

    assert.equal(result, "Could not find \"/workspace/skill/MISSING.md\" on disk.");
    assert.equal(openPathCalled, false);
    assert.equal(revealCalled, false);
  });

  it("selects an existing file on Windows too, rather than only opening its folder", async () => {
    let revealedPath = "";
    let openPathCalled = false;

    const result = await revealItemInDir("C:\\workspace\\skill\\SKILL.md", {
      existsSync: (target) => target === "C:\\workspace\\skill\\SKILL.md",
      openPath: async () => {
        openPathCalled = true;
        return "";
      },
      platform: "win32",
      showItemInFolder: (target) => {
        revealedPath = target;
      },
    });

    assert.equal(result, undefined);
    assert.equal(revealedPath, "C:\\workspace\\skill\\SKILL.md");
    assert.equal(openPathCalled, false);
  });

  it("propagates a parent-open failure so the caller can surface it", async () => {
    const result = await revealItemInDir("C:\\workspace\\skill\\MISSING.md", {
      existsSync: (target) => target === "C:\\workspace\\skill",
      openPath: async () => "Explorer failed",
      platform: "win32",
      showItemInFolder: () => {
        throw new Error("showItemInFolder must not run for a missing target");
      },
    });

    assert.equal(result, "Explorer failed");
  });

  it("uses Windows path semantics when resolving the parent directory", async () => {
    let openedPath = "";

    await revealItemInDir("C:\\workspace\\skill\\MISSING.md", {
      existsSync: (target) => target === "C:\\workspace\\skill",
      openPath: async (target) => {
        openedPath = target;
        return "";
      },
      platform: "win32",
      showItemInFolder: () => {},
    });

    assert.equal(openedPath, "C:\\workspace\\skill");
  });
});
