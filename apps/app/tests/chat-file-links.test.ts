import { describe, expect, test } from "bun:test";

import { inlineCodeArtifactPath, renderMarkdownHtml } from "../src/components/markdown/markdown-primitive";
import {
  parseLocalPathReference,
  resolveLocalPath,
  workspaceLookupValue,
  workspaceRelativePath,
} from "../src/react-app/domains/session/artifacts/local-path";
import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import {
  localArtifactPath,
  nativeFileAction,
  openTargetForHref,
  openTargetFromLocalPath,
  planFileOpen,
} from "../src/react-app/domains/session/artifacts/resolve-open-target";

const ROOT = "/Users/me/openwork-repo";
const HOME = "/Users/me";

function fileTarget(value: string, extra: Partial<OpenTarget> = {}): OpenTarget {
  return { id: `file:${value}`, kind: "file", value, name: value.split("/").pop() ?? value, preview: "code", confidence: 95, reason: "artifact", ...extra };
}

describe("parseLocalPathReference", () => {
  test("reads home-relative paths without resolving them", () => {
    expect(parseLocalPathReference("~/Downloads/openwork-launch-edit.mp4")).toEqual({
      path: "~/Downloads/openwork-launch-edit.mp4",
      anchor: "home",
      bare: false,
    });
  });

  test("separates :line and :line:col suffixes from bare file names", () => {
    expect(parseLocalPathReference("computer-control.test.mjs:813")).toEqual({
      path: "computer-control.test.mjs",
      anchor: "relative",
      bare: true,
      line: 813,
    });
    expect(parseLocalPathReference("src/app.ts:12:5")).toEqual({
      path: "src/app.ts",
      anchor: "relative",
      bare: false,
      line: 12,
      column: 5,
    });
  });

  test("understands the other common line notations", () => {
    expect(parseLocalPathReference("src/app.ts#L40")).toMatchObject({ path: "src/app.ts", line: 40 });
    expect(parseLocalPathReference("src/app.ts#L40-L52")).toMatchObject({ path: "src/app.ts", line: 40 });
    expect(parseLocalPathReference("src/app.ts#L4C2")).toMatchObject({ path: "src/app.ts", line: 4, column: 2 });
    expect(parseLocalPathReference("src/app.ts(12,3)")).toMatchObject({ path: "src/app.ts", line: 12, column: 3 });
  });

  test("keeps absolute and Windows paths absolute", () => {
    expect(parseLocalPathReference("/Users/me/notes/plan.md:3")).toEqual({
      path: "/Users/me/notes/plan.md",
      anchor: "absolute",
      bare: false,
      line: 3,
    });
    expect(parseLocalPathReference("C:\\Users\\me\\plan.md:7:1")).toMatchObject({
      path: "C:\\Users\\me\\plan.md",
      anchor: "absolute",
      line: 7,
      column: 1,
    });
  });

  test("reads local file:// URLs, including encoded names and #L anchors", () => {
    expect(parseLocalPathReference("file:///Users/me/Acme%20Quote.pdf")).toMatchObject({
      path: "/Users/me/Acme Quote.pdf",
      anchor: "absolute",
    });
    expect(parseLocalPathReference("file://localhost/Users/me/a.ts#L9")).toMatchObject({ path: "/Users/me/a.ts", line: 9 });
    expect(parseLocalPathReference("file:///C:/Users/me/plan.md")).toMatchObject({ path: "C:/Users/me/plan.md", anchor: "absolute" });
  });

  test("strips quotes, brackets and trailing sentence punctuation", () => {
    expect(parseLocalPathReference("\"docs/plan.md\"")?.path).toBe("docs/plan.md");
    expect(parseLocalPathReference("'docs/plan.md',")?.path).toBe("docs/plan.md");
    expect(parseLocalPathReference("(see-notes.md).")?.path).toBe("see-notes.md");
    expect(parseLocalPathReference("\u201creport.pdf\u201d")?.path).toBe("report.pdf");
    expect(parseLocalPathReference("`main.mjs:20`.")).toMatchObject({ path: "main.mjs", line: 20 });
    expect(parseLocalPathReference("notes.md:")?.path).toBe("notes.md");
    expect(parseLocalPathReference("<./docs/plan.md>")?.path).toBe("docs/plan.md");
  });

  test("keeps brackets that belong to the file name", () => {
    expect(parseLocalPathReference("chart(1).png")?.path).toBe("chart(1).png");
    expect(parseLocalPathReference("(chart(1).png)")?.path).toBe("chart(1).png");
    expect(parseLocalPathReference("Ben's notes.md")?.path).toBe("Ben's notes.md");
  });

  test("decodes link destinations only when asked", () => {
    expect(parseLocalPathReference("Acme%20Quote.pdf")?.path).toBe("Acme%20Quote.pdf");
    expect(parseLocalPathReference("Acme%20Quote.pdf", { decode: true })?.path).toBe("Acme Quote.pdf");
    expect(parseLocalPathReference("50% off.pdf", { decode: true })?.path).toBe("50% off.pdf");
  });

  test("turns away things that are not local file paths", () => {
    for (const value of [
      "",
      "   ",
      "https://example.com/a.pdf",
      "mailto:me@example.com",
      "javascript:alert(1)",
      "file://server/share/a.pdf",
      "file:///tmp/a.pdf?x=1",
      "//server/share/a.pdf",
      "\\\\server\\share\\a.pdf",
      "~",
      "~someone/notes.md",
      "../secrets.txt",
      "docs/../../secrets.txt",
      "~/../etc/passwd",
      "a\u0000b.txt",
      "docs/",
    ]) {
      expect(parseLocalPathReference(value)).toBeNull();
    }
  });
});

describe("resolveLocalPath", () => {
  const context = { workspaceRoot: ROOT, homeDir: HOME };

  test("expands ~ with the home folder and joins workspace paths to the root", () => {
    expect(resolveLocalPath(parseLocalPathReference("~/Downloads/clip.mp4")!, context)).toBe("/Users/me/Downloads/clip.mp4");
    expect(resolveLocalPath(parseLocalPathReference("docs/plan.md")!, context)).toBe(`${ROOT}/docs/plan.md`);
    expect(resolveLocalPath(parseLocalPathReference("/etc/hosts")!, context)).toBe("/etc/hosts");
  });

  test("cannot resolve without the folder it depends on", () => {
    expect(resolveLocalPath(parseLocalPathReference("~/Downloads/clip.mp4")!, { workspaceRoot: ROOT })).toBeNull();
    expect(resolveLocalPath(parseLocalPathReference("docs/plan.md")!, { homeDir: HOME })).toBeNull();
    expect(resolveLocalPath(parseLocalPathReference("docs/plan.md")!, { workspaceRoot: "relative/root" })).toBeNull();
  });

  test("asks the workspace with a workspace-relative path whenever it can", () => {
    expect(workspaceLookupValue(parseLocalPathReference("~/openwork-repo/docs/plan.md")!, context)).toBe("docs/plan.md");
    expect(workspaceLookupValue(parseLocalPathReference(`${ROOT}/docs/plan.md:4`)!, context)).toBe("docs/plan.md");
    expect(workspaceLookupValue(parseLocalPathReference("~/Downloads/clip.mp4")!, context)).toBe("/Users/me/Downloads/clip.mp4");
    expect(workspaceLookupValue(parseLocalPathReference("main.mjs:3")!, context)).toBe("main.mjs");
    expect(workspaceRelativePath(ROOT, `${ROOT}/../elsewhere/a.md`)).toBeNull();
    expect(workspaceRelativePath(ROOT, `${ROOT}-other/a.md`)).toBeNull();
  });
});

describe("inline code links", () => {
  test("links file references, without their line suffix", () => {
    expect(inlineCodeArtifactPath("computer-control.test.mjs:813")).toBe("computer-control.test.mjs");
    expect(inlineCodeArtifactPath("~/Downloads/openwork-launch-edit.mp4")).toBe("~/Downloads/openwork-launch-edit.mp4");
    expect(inlineCodeArtifactPath("apps/desktop/electron/main.mjs:2341:7")).toBe("apps/desktop/electron/main.mjs");
    expect(inlineCodeArtifactPath("/Users/me/report.pdf")).toBe("/Users/me/report.pdf");
    expect(inlineCodeArtifactPath("data/export.csv")).toBe("data/export.csv");
  });

  test("leaves code that is not a file path alone", () => {
    for (const value of [
      "pnpm install",
      "foo.bar()",
      "https://example.com/a.md",
      "file:///Users/me/a.md",
      "a:b.ts",
      "../outside.md",
      "~someone/notes.md",
      "README",
      "v0.18.64",
      ".env",
    ]) {
      expect(inlineCodeArtifactPath(value)).toBeNull();
    }
  });
});

describe("rendered chat Markdown", () => {
  test("makes file references clickable with clean paths", () => {
    const html = renderMarkdownHtml("See `computer-control.test.mjs:813` and [the plan](docs/plan.md:3).", "chat");
    expect(html).toContain("data-openwork-inline-code-path=\"computer-control.test.mjs\"");
    expect(html).toContain(">computer-control.test.mjs:813</code>");
    expect(html).toContain("data-openwork-link-href=\"docs/plan.md:3\"");
  });

  test("keeps a home-folder video as a reference instead of a player that cannot load", () => {
    const html = renderMarkdownHtml("Saved to `~/Downloads/openwork-launch-edit.mp4`.", "chat");
    expect(html).toContain("data-openwork-inline-code-path=\"~/Downloads/openwork-launch-edit.mp4\"");
    expect(html).not.toContain("<video");
  });

  test("does not link destinations that cannot open", () => {
    const html = renderMarkdownHtml("[top](#top) and [share](//server/share/a.pdf)", "chat");
    expect(html).not.toContain("data-openwork-link-href");
    expect(html).toContain("top");
    expect(html).toContain("share");
  });
});

describe("Markdown link destinations", () => {
  test("open the same cleaned file target as inline code", () => {
    expect(openTargetForHref("computer-control.test.mjs:813", [], ROOT)).toMatchObject({ kind: "file", value: "computer-control.test.mjs", name: "computer-control.test.mjs", preview: "code" });
    expect(openTargetForHref("~/Downloads/clip.mp4", [], ROOT)).toMatchObject({ kind: "file", value: "~/Downloads/clip.mp4" });
    expect(openTargetForHref("file:///Users/me/Acme%20Quote.pdf", [], ROOT)).toMatchObject({ value: "/Users/me/Acme Quote.pdf", preview: "pdf" });
    expect(openTargetForHref("Acme%20Quote.pdf", [], ROOT)).toMatchObject({ value: "Acme Quote.pdf" });
    expect(openTargetForHref("https://example.com", [], ROOT)).toMatchObject({ kind: "url" });
    expect(openTargetForHref("#heading", [], ROOT)).toBeNull();
    expect(openTargetForHref("mailto:me@example.com", [], ROOT)).toBeNull();
  });

  test("reuse a verified target for the same file", () => {
    const verified = fileTarget("docs/plan.md", { exists: true });
    expect(openTargetForHref(`${ROOT}/docs/plan.md:10`, [verified], ROOT)).toBe(verified);
    expect(openTargetForHref("./docs/plan.md", [verified], ROOT)).toBe(verified);
  });

  test("openTargetFromLocalPath rejects references that cannot open", () => {
    expect(openTargetFromLocalPath("https://example.com")).toBeNull();
    expect(openTargetFromLocalPath("report.pdf:2")).toMatchObject({ value: "report.pdf", preview: "pdf" });
  });
});

describe("native file actions", () => {
  test("open inside the workspace, reveal outside it", () => {
    expect(nativeFileAction(ROOT, "docs/plan.md:3")).toEqual({ path: `${ROOT}/docs/plan.md`, action: "open" });
    expect(nativeFileAction(ROOT, "~/Downloads/clip.mp4", { homeDir: HOME })).toEqual({ path: "/Users/me/Downloads/clip.mp4", action: "reveal" });
    expect(nativeFileAction(ROOT, "~/openwork-repo/docs/plan.md", { homeDir: HOME })).toEqual({ path: `${ROOT}/docs/plan.md`, action: "open" });
    expect(nativeFileAction(ROOT, "docs/plan.md", { reveal: true })).toEqual({ path: `${ROOT}/docs/plan.md`, action: "reveal" });
    expect(nativeFileAction(ROOT, `${ROOT}/../escape.sh`)).toEqual({ path: `${ROOT}/../escape.sh`, action: "reveal" });
  });

  test("never act on URLs, shares or unknown home folders", () => {
    expect(nativeFileAction(ROOT, "https://example.com/a.pdf")).toBeNull();
    expect(nativeFileAction(ROOT, "//server/share/a.pdf")).toBeNull();
    expect(nativeFileAction(ROOT, "~/Downloads/clip.mp4")).toBeNull();
    expect(localArtifactPath(ROOT, "file:///Users/me/a%20b.md")).toBe("/Users/me/a b.md");
  });
});

describe("planFileOpen", () => {
  const found = (value: string): OpenTarget => fileTarget(value, { exists: true });

  test("finds a bare file name with a line suffix through the workspace search", async () => {
    const lookups: string[] = [];
    const plan = await planFileOpen(fileTarget("computer-control.test.mjs:813"), {
      workspaceRoot: ROOT,
      homeDir: HOME,
      canOpenLocally: true,
      findInWorkspace: async (lookup) => {
        lookups.push(lookup.value);
        return lookup.value === "computer-control.test.mjs" ? found("apps/desktop/electron/computer-control.test.mjs") : null;
      },
    });
    expect(lookups).toEqual(["computer-control.test.mjs"]);
    expect(plan).toEqual({ kind: "workspace", target: found("apps/desktop/electron/computer-control.test.mjs") });
  });

  test("reveals a home-folder file outside the workspace instead of failing", async () => {
    const plan = await planFileOpen(fileTarget("~/Downloads/openwork-launch-edit.mp4"), {
      workspaceRoot: ROOT,
      homeDir: HOME,
      canOpenLocally: true,
      findInWorkspace: async () => null,
    });
    expect(plan).toMatchObject({ kind: "native", path: "/Users/me/Downloads/openwork-launch-edit.mp4", action: "reveal" });
  });

  test("looks up a home path that lands in the workspace by its workspace path", async () => {
    const lookups: string[] = [];
    await planFileOpen(fileTarget("~/openwork-repo/docs/plan.md"), {
      workspaceRoot: ROOT,
      homeDir: HOME,
      canOpenLocally: true,
      findInWorkspace: async (lookup) => { lookups.push(lookup.value); return null; },
    });
    expect(lookups).toEqual(["docs/plan.md"]);
  });

  test("says the file was not found instead of opening a guessed path", async () => {
    const plan = await planFileOpen(fileTarget("missing.mjs:12"), {
      workspaceRoot: ROOT,
      canOpenLocally: true,
      findInWorkspace: async () => null,
    });
    expect(plan).toEqual({ kind: "unavailable", message: "Couldn\u2019t find \u201cmissing.mjs\u201d in this workspace." });
  });

  test("explains a reference that is not a file", async () => {
    const plan = await planFileOpen(fileTarget("https://example.com/a.pdf", { name: "a.pdf" }), { workspaceRoot: ROOT, canOpenLocally: true });
    expect(plan).toEqual({ kind: "unavailable", message: "\u201ca.pdf\u201d is not a file OpenWork can open." });
  });

  test("opens verified workspace files directly", async () => {
    const target = found("docs/plan.md");
    let searched = false;
    const plan = await planFileOpen(target, { workspaceRoot: ROOT, canOpenLocally: true, findInWorkspace: async () => { searched = true; return null; } });
    expect(plan).toEqual({ kind: "workspace", target });
    expect(searched).toBe(false);
  });

  test("falls back to the desktop when the workspace is not connected", async () => {
    expect(await planFileOpen(fileTarget("docs/plan.md:2"), { workspaceRoot: ROOT, canOpenLocally: true }))
      .toMatchObject({ kind: "native", path: `${ROOT}/docs/plan.md`, action: "open" });
    expect(await planFileOpen(fileTarget("docs/plan.md"), { workspaceRoot: ROOT, canOpenLocally: false }))
      .toEqual({ kind: "unavailable", message: "Connect to the workspace to open this file." });
  });

  test("reports a missing file in the web app without trying the desktop", async () => {
    expect(await planFileOpen(fileTarget("/Users/me/a.md"), { workspaceRoot: ROOT, canOpenLocally: false, findInWorkspace: async () => null }))
      .toEqual({ kind: "unavailable", message: "Couldn\u2019t find \u201c/Users/me/a.md\u201d in this workspace." });
  });
});
