/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { parseLocalPathReference } from "../src/react-app/domains/session/artifacts/local-path";
import { deriveSessionFileEvidence, type OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { contextualizeFileTarget, directoryReference, precedingDirectory, sessionFileCandidate } from "../src/react-app/domains/session/artifacts/path-reference-context";
import { openTargetForHref, openTargetFromLocalPath, planFileOpen } from "../src/react-app/domains/session/artifacts/resolve-open-target";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { MarkdownBlock } = await import("../src/components/markdown/markdown");
const { OpenTargetProvider } = await import("../src/lib/target-provider");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { renderMarkdownHtml } = await import("../src/components/markdown/markdown-primitive");

const HOME = "/Users/test";
const ROOT = `${HOME}/workspace`;
const DIRECTORY = "~/Desktop/OpenWork open-model benchmark/";
const ABS_DIRECTORY = `${HOME}/Desktop/OpenWork open-model benchmark/`;
const FILE = "results.csv";

function file(value: string, extra: Partial<OpenTarget> = {}): OpenTarget {
  const target = openTargetFromLocalPath(value);
  if (!target) throw new Error(`Invalid fixture path: ${value}`);
  return { ...target, ...extra };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture element or reference");
  return value;
}
function reference(value: string) {
  return required(parseLocalPathReference(value));
}
function markdownRoot(text: string) {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHtml(text, "chat");
  return root;
}

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function render(text: string, onOpenTarget: (target: OpenTarget) => void, streaming = false, targets: OpenTarget[] = []) {
  await act(async () => root?.render(
    <PlatformProvider value={createDefaultPlatform()}>
      <OpenTargetProvider workspaceRoot={ROOT} openTargets={targets} onOpenTarget={onOpenTarget}>
        <MarkdownBlock text={text} streaming={streaming} />
      </OpenTargetProvider>
    </PlatformProvider>,
  ));
}
async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
function inline(index = 0) {
  return required(host.querySelectorAll<HTMLElement>("[data-openwork-inline-code-path]").item(index));
}
function link(index = 0) {
  return required(host.querySelectorAll<HTMLAnchorElement>("a[data-openwork-link-href]").item(index));
}
async function openMenu(element: Element, kind: "contextmenu" | "chevron") {
  if (kind === "chevron") await click(element);
  else await act(async () => {
    element.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  const button = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.trim() === "Open in panel");
  await click(required(button));
}

describe("directory reference context", () => {
  test("listed child folders don't replace the handoff directory for sibling reports", () => {
    const element = markdownRoot(`Files are in \`${DIRECTORY}\`:\n\n- \`scenes/\`\n- \`benchmark-report.md\`\n\nCode is in \`~/other-repo/\``);
    const report = required(element.querySelector("[data-openwork-inline-code-path]"));
    expect(precedingDirectory(element, report)).toBe(DIRECTORY);
  });

  test("directory link destinations decode once, while code directory names stay literal", () => {
    const linked = markdownRoot("[Outputs](results/Benchmark%20r%C3%A9sum%C3%A9/) then `report.md`");
    expect(precedingDirectory(linked, required(linked.querySelector("code")))).toBe("results/Benchmark résumé/");
    expect(directoryReference("file:///Users/test/literal%2520folder/", true)).toBe("/Users/test/literal%20folder/");
  });
  test("accepts explicit directories with spaces and Unicode, without decoding literal percent names", () => {
    expect(directoryReference(DIRECTORY)).toBe(DIRECTORY);
    expect(directoryReference(`${HOME}/résultats 模型/`)).toBe(`${HOME}/résultats 模型/`);
    expect(directoryReference("~/Desktop/literal%20folder/")).toBe("~/Desktop/literal%20folder/");
    for (const invalid of ["~/Desktop/folder", "folder", "../outside/", "docs/../../outside/", "~/../outside/", "https://example.test/files/", "//server/share/", "a\u0000b/"]) {
      expect(directoryReference(invalid)).toBeNull();
    }
  });

  test("only the nearest preceding explicit directory applies, even when two lists repeat the filename", () => {
    const element = markdownRoot(`Before: \`${FILE}\`\n\nSaved in \`${DIRECTORY}\`:\n\n- \`${FILE}\`\n- [report](report.md)\n\nNext: \`~/Desktop/other models/\`\n\n- \`${FILE}\`\n\nLater: \`~/Desktop/must not apply/\``);
    const nodes = Array.from(element.querySelectorAll("[data-openwork-inline-code-path], a[data-openwork-link-href]"));
    expect(nodes).toHaveLength(4);
    expect(nodes.map((node) => precedingDirectory(element, node))).toEqual([
      null, DIRECTORY, DIRECTORY, "~/Desktop/other models/",
    ]);
  });

  test("directory-looking fenced examples and ordinary prose never supply a base", () => {
    const element = markdownRoot(`The directory is ~/Desktop/not evidence/.\n\n\`\`\`text\n~/Desktop/example/\n\`\`\`\n\n\`${FILE}\``);
    expect(precedingDirectory(element, required(element.querySelector("[data-openwork-inline-code-path]")))).toBeNull();
  });

  test("context contributes a candidate, never rewrites a file identity or its explicit absolute/home path", () => {
    expect(contextualizeFileTarget(file(FILE), DIRECTORY)).toEqual(file(FILE, { pathHints: [`${DIRECTORY}${FILE}`] }));
    for (const target of [
      file(`${HOME}/Documents/${FILE}`), file(`~/Documents/${FILE}`),
      file(FILE, { fileScope: "conversation", resolvedPath: `${ROOT}/conversation/${FILE}` }),
      file(FILE, { fileScope: "workspace" }), file(FILE, { resolvedPath: `${ROOT}/exact/${FILE}` }),
    ]) {
      expect(contextualizeFileTarget(target, DIRECTORY)).toBe(target);
    }
    const target = file(FILE);
    expect(contextualizeFileTarget(target, null)).toBe(target);
    expect(openTargetFromLocalPath("../outside.csv")).toBeNull();
    expect(openTargetForHref("%2e%2e/outside.csv", [], ROOT)).toBeNull();
  });

  test("a unique session suffix is evidence, but bare mentions and ambiguous identities are not", () => {
    const target = file(`${ABS_DIRECTORY}${FILE}`);
    expect(sessionFileCandidate(reference(FILE), [target])).toBe(target);
    expect(sessionFileCandidate(reference(FILE), [target, { ...target }])).toEqual(target);
    expect(sessionFileCandidate(reference(FILE), [file(FILE)])).toBeNull();
    expect(sessionFileCandidate(reference(FILE), [target, file(`${ROOT}/other/${FILE}`)])).toBeNull();
    expect(sessionFileCandidate(reference(FILE), [file(`not-${FILE}`)])).toBeNull();
    expect(sessionFileCandidate(reference(FILE), [file(FILE, { fileScope: "workspace" }), file(FILE, { fileScope: "conversation" })])).toBeNull();
    expect(sessionFileCandidate(reference(`~/Desktop/${FILE}`), [target])).toBeNull();
  });
});

describe("chat file activation", () => {
  for (const streaming of [false, true]) {
    test(`inline mouse and Enter/Space activation retain the occurrence's directory (${streaming ? "streaming" : "settled"})`, async () => {
      const opened = mock<(target: OpenTarget) => void>();
      await render(`Saved to \`${DIRECTORY}\`:\n\n- \`${FILE}\`\n\nOther list: \`~/Desktop/other models/\`\n\n- \`${FILE}\`\n\nLater: \`~/Desktop/later/\``, opened, streaming);
      await click(inline(0));
      for (const key of ["Enter", " "]) {
        await act(async () => { inline(1).dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
      }
      expect(opened.mock.calls.map(([target]) => target.pathHints)).toEqual([
        [`${DIRECTORY}${FILE}`], ["~/Desktop/other models/results.csv"], ["~/Desktop/other models/results.csv"],
      ]);
      expect(opened.mock.calls.every(([target]) => target.value === FILE && target.exists === undefined && target.fileScope === undefined)).toBe(true);
    });

    test(`Markdown mouse and menu activation use the same occurrence, not a same-named artifact (${streaming ? "streaming" : "settled"})`, async () => {
      const opened = mock<(target: OpenTarget) => void>();
      const unrelated = file(FILE, { exists: true, fileScope: "workspace", resolvedPath: `${ROOT}/${FILE}` });
      await render(`\`${DIRECTORY}\`\n\n[report](${FILE})\n\n\`~/Desktop/other models/\`\n\n[report](${FILE})`, opened, streaming, [unrelated]);
      await click(link(0));
      await openMenu(link(1), "contextmenu");
      await openMenu(required(host.querySelector("[data-openwork-link-chevron]")), "chevron");
      expect(opened.mock.calls.map(([target]) => target.pathHints)).toEqual([
        [`${DIRECTORY}${FILE}`], ["~/Desktop/other models/results.csv"], [`${DIRECTORY}${FILE}`],
      ]);
      expect(opened.mock.calls.every(([target]) => target.fileScope === undefined)).toBe(true);
    });
  }

  test("a filename before the first directory is never assigned a later location", async () => {
    const opened = mock<(target: OpenTarget) => void>();
    await render(`\`${FILE}\` and [report](${FILE})\n\n\`${DIRECTORY}\``, opened);
    await click(inline());
    await click(link());
    expect(opened.mock.calls.map(([target]) => target.pathHints)).toEqual([undefined, undefined]);
  });

  test("literal inline percent names differ from once-decoded Markdown destinations, preserving spaces and Unicode", async () => {
    const opened = mock<(target: OpenTarget) => void>();
    await render(`\`${DIRECTORY}\`\n\n- \`model%20scores.csv\`\n- [encoded](model%20scores.csv)\n- [literal percent](model%2520scores.csv)\n- \`résumé 模型.csv\`\n- [Unicode](r%C3%A9sum%C3%A9%20%E6%A8%A1%E5%9E%8B.csv)`, opened);
    await click(inline(0));
    await click(link(0));
    await click(link(1));
    await click(inline(1));
    await click(link(2));
    expect(opened.mock.calls.map(([target]) => [target.value, target.pathHints])).toEqual([
      ["model%20scores.csv", [`${DIRECTORY}model%20scores.csv`]],
      ["model scores.csv", [`${DIRECTORY}model scores.csv`]],
      ["model%20scores.csv", [`${DIRECTORY}model%20scores.csv`]],
      ["résumé 模型.csv", [`${DIRECTORY}résumé 模型.csv`]],
      ["résumé 模型.csv", [`${DIRECTORY}résumé 模型.csv`]],
    ]);
  });

  test("explicit absolute and home references ignore preceding directories", async () => {
    const opened = mock<(target: OpenTarget) => void>();
    await render(`\`${DIRECTORY}\`\n\n\`${HOME}/Documents/${FILE}\` and [explicit](file://${HOME}/Documents/model%20scores.csv) and \`~/Documents/${FILE}\``, opened);
    await click(inline(0));
    await click(link());
    await click(inline(1));
    expect(opened.mock.calls.map(([target]) => target.value)).toEqual([`${HOME}/Documents/${FILE}`, `${HOME}/Documents/model scores.csv`, `~/Documents/${FILE}`]);
    expect(opened.mock.calls.every(([target]) => target.pathHints === undefined)).toBe(true);
  });

  test("invalid traversal references never activate", async () => {
    const opened = mock<(target: OpenTarget) => void>();
    await render(`\`${DIRECTORY}\`\n\n\`../outside.csv\` and [escape](%2e%2e/outside.csv) and \`docs/../../outside.csv\``, opened);
    for (const element of host.querySelectorAll("code, a")) await click(element);
    expect(opened).not.toHaveBeenCalled();
  });
});

test("an outside-workspace video falls back to a contextual clickable reference without decoding literal code", async () => {
  const opened = mock((_target: OpenTarget) => {});
  await render(`Files are in \`${DIRECTORY}\`:\n\n- \`open-model-benchmark-full.mp4\`\n- \`literal%20video.mp4\`\n- [encoded video](clip%20full.mp4)`, opened);
  expect(host.querySelector("video")).toBeNull();
  await click(inline(0));
  expect(opened.mock.calls[0]?.[0]).toMatchObject({ value: "open-model-benchmark-full.mp4", pathHints: [`${DIRECTORY}open-model-benchmark-full.mp4`] });
  await click(inline(1));
  expect(opened.mock.calls[1]?.[0]).toMatchObject({ value: "literal%20video.mp4", pathHints: [`${DIRECTORY}literal%20video.mp4`] });
  await click(link());
  expect(opened.mock.calls[2]?.[0]).toMatchObject({ value: "clip full.mp4", pathHints: [`${DIRECTORY}clip full.mp4`] });
});

describe("contextual file open planning", () => {
  test("a disconnected local server can still reveal a verified contextual file", async () => {
    expect(await planFileOpen(contextualizeFileTarget(file(FILE), DIRECTORY), {
      origin: "local", workspaceRoot: ROOT, homeDir: HOME, canOpenLocally: true,
      findInWorkspace: async () => { throw new Error("Local runtime offline"); },
      findOnComputer: async (path) => path === `${ABS_DIRECTORY}${FILE}` ? path : null,
    })).toMatchObject({ kind: "native", path: `${ABS_DIRECTORY}${FILE}`, action: "reveal" });
  });
  test("checks contextual candidates exactly before the written path, unique evidence, and bounded workspace search", async () => {
    const lookups: Array<[string, boolean | undefined]> = [];
    const evidence = file(`${ROOT}/tool-output/${FILE}`);
    const searched = file(`nested/${FILE}`, { exists: true });
    const target = contextualizeFileTarget(file(FILE), DIRECTORY);
    const plan = await planFileOpen(target, {
      origin: "local", workspaceRoot: ROOT, homeDir: HOME, canOpenLocally: true, sessionTargets: [evidence],
      findInWorkspace: async (candidate, options) => {
        lookups.push([candidate.value, options?.search]);
        return options?.search ? searched : null;
      },
    });
    expect(lookups).toEqual([[`${ABS_DIRECTORY}${FILE}`, false], [FILE, false], [`tool-output/${FILE}`, false], [FILE, true]]);
    expect(plan).toEqual({ kind: "workspace", target: searched });
  });

  test("an exact contextual result wins over an unrelated same-named workspace file", async () => {
    const exact = file(`benchmarks/${FILE}`, { exists: true });
    const lookups: string[] = [];
    expect(await planFileOpen(contextualizeFileTarget(file(FILE), DIRECTORY), {
      origin: "local", workspaceRoot: ROOT, homeDir: HOME, canOpenLocally: true,
      findInWorkspace: async (candidate, options) => {
        lookups.push(candidate.value);
        return options?.search === false ? exact : file(`wrong/${FILE}`, { exists: true });
      },
    })).toEqual({ kind: "workspace", target: exact });
    expect(lookups).toEqual([`${ABS_DIRECTORY}${FILE}`]);
  });

  test("a unique successful tool path resolves a bare name before workspace search", async () => {
    const evidence = file(`${ABS_DIRECTORY}${FILE}`);
    const found = file(`artifacts/${FILE}`, { exists: true });
    const lookups: Array<[string, boolean | undefined]> = [];
    expect(await planFileOpen(file(FILE), {
      origin: "remote", workspaceRoot: ROOT, canOpenLocally: true, sessionTargets: [evidence],
      findInWorkspace: async (candidate, options) => {
        lookups.push([candidate.value, options?.search]);
        return candidate.value === evidence.value ? found : null;
      },
    })).toEqual({ kind: "workspace", target: found });
    expect(lookups).toEqual([[FILE, false], [evidence.value, false]]);
  });

  test("ambiguous session paths are ignored rather than choosing the first matching file", async () => {
    const lookups: Array<[string, boolean | undefined]> = [];
    const plan = await planFileOpen(file(FILE), {
      origin: "local", workspaceRoot: ROOT, canOpenLocally: true,
      sessionTargets: [file(`${ROOT}/a/${FILE}`), file(`${ROOT}/b/${FILE}`)],
      findInWorkspace: async (candidate, options) => { lookups.push([candidate.value, options?.search]); return null; },
    });
    expect(plan.kind).toBe("unavailable");
    expect(lookups).toEqual([[FILE, true]]);
  });

  test("the native existence callback advances past a missing hinted path to the next existing candidate", async () => {
    const checked: string[] = [];
    const workspace: Array<[string, boolean | undefined]> = [];
    const nativePath = `${HOME}/Documents/existing/${FILE}`;
    const plan = await planFileOpen(file(FILE, { pathHints: [`~/Desktop/missing/${FILE}`, nativePath] }), {
      origin: "local", workspaceRoot: ROOT, homeDir: HOME, canOpenLocally: true,
      findInWorkspace: async (candidate, options) => { workspace.push([candidate.value, options?.search]); return null; },
      findOnComputer: async (path) => { checked.push(path); return path === nativePath ? path : null; },
    });
    expect(checked).toEqual([`${HOME}/Desktop/missing/${FILE}`, nativePath]);
    expect(workspace).toEqual([[`${HOME}/Desktop/missing/${FILE}`, false], [nativePath, false]]);
    expect(plan).toMatchObject({ kind: "native", path: nativePath, action: "reveal" });
  });

  test("native canonical paths, not the hinted workspace prefix, decide open versus reveal", async () => {
    const canonical = `${HOME}/Documents/outside/${FILE}`;
    const checked: string[] = [];
    const plan = await planFileOpen(file(FILE, { pathHints: [`${ROOT}/linked/${FILE}`] }), {
      origin: "local", workspaceRoot: ROOT, canOpenLocally: true,
      findInWorkspace: async () => null,
      findOnComputer: async (path) => { checked.push(path); return canonical; },
    });
    expect(checked).toEqual([`${ROOT}/linked/${FILE}`]);
    expect(plan).toMatchObject({ kind: "native", path: canonical, action: "reveal" });
    expect(await planFileOpen(file(FILE), {
      origin: "local", workspaceRoot: ROOT, canOpenLocally: true,
      findOnComputer: async () => `${ROOT}/real/${FILE}`,
    })).toMatchObject({ kind: "native", path: `${ROOT}/real/${FILE}`, action: "open" });
  });

  test("an existence callback returning null never falls back to a guessed native path", async () => {
    expect(await planFileOpen(contextualizeFileTarget(file(FILE), DIRECTORY), {
      origin: "local", workspaceRoot: ROOT, homeDir: HOME, canOpenLocally: true,
      findInWorkspace: async () => null, findOnComputer: async () => null,
    })).toEqual({ kind: "unavailable", message: "OpenWork couldn't find this file on this computer." });
  });

  for (const origin of ["remote", "unknown"] satisfies Array<"remote" | "unknown">) {
    test(`${origin} origins never invoke this computer's existence callback or return native plans`, async () => {
      const native = mock(async (path: string) => path);
      const lookups: string[] = [];
      const plan = await planFileOpen(contextualizeFileTarget(file(FILE), DIRECTORY), {
        origin, workspaceRoot: ROOT, homeDir: HOME, canOpenLocally: true,
        sessionTargets: [file(`${ABS_DIRECTORY}${FILE}`)],
        findInWorkspace: async (candidate) => { lookups.push(candidate.value); return null; },
        findOnComputer: native,
      });
      expect(native).not.toHaveBeenCalled();
      expect(lookups[0]).toBe(`${DIRECTORY}${FILE}`);
      expect(plan).toEqual({ kind: "unavailable", message: "This file is on another machine or is no longer available." });
    });
  }

  test("scoped and resolved identities are exact-only and never rebound to context or another session suffix", async () => {
    for (const identity of [
      { fileScope: "conversation", resolvedPath: `${ROOT}/conversation/${FILE}` },
      { fileScope: "workspace" },
      { resolvedPath: `${ROOT}/original/${FILE}` },
    ] satisfies Partial<OpenTarget>[]) {
      const pinned = file(FILE, { exists: true, pathHints: [`${DIRECTORY}${FILE}`], ...identity });
      const lookups: Array<[string, boolean | undefined, OpenTarget["fileScope"]]> = [];
      expect(await planFileOpen(pinned, {
        origin: "remote", workspaceRoot: ROOT, canOpenLocally: true,
        sessionTargets: [file(`${ROOT}/unrelated/${FILE}`)],
        findInWorkspace: async (candidate, options) => {
          lookups.push([candidate.value, options?.search, candidate.fileScope]);
          return options?.search ? file(`wrong/${FILE}`, { exists: true }) : null;
        },
      })).toMatchObject({ kind: "unavailable" });
      expect(lookups).toEqual([[identity.fileScope ? FILE : identity.resolvedPath?.slice(ROOT.length + 1) ?? FILE, false, identity.fileScope]]);
    }
  });

  test("a conversation-scoped identity without an absolute path never probes the workspace-root decoy", async () => {
    const native = mock(async (path: string) => path);
    expect(await planFileOpen(file(FILE, { exists: true, fileScope: "conversation" }), {
      origin: "local", workspaceRoot: ROOT, canOpenLocally: true,
      findInWorkspace: async () => null, findOnComputer: native,
    })).toMatchObject({ kind: "unavailable" });
    expect(native).not.toHaveBeenCalled();
  });

  test("deleted verified references are rechecked without searching for a replacement", async () => {
    const target = file(FILE, { exists: true, fileScope: "conversation", resolvedPath: `${ROOT}/conversation/${FILE}` });
    const finder = mock(async (_candidate: OpenTarget, _options?: { search: boolean }) => null);
    const native = mock(async (_path: string) => null);
    const plan = await planFileOpen(target, {
      origin: "local", workspaceRoot: ROOT, canOpenLocally: true, findInWorkspace: finder, findOnComputer: native,
      sessionTargets: [file(`${ROOT}/replacement/${FILE}`)],
    });
    expect(plan).toMatchObject({ kind: "unavailable" });
    expect(finder).toHaveBeenCalledTimes(1);
    expect(finder.mock.calls[0]?.[1]).toEqual({ search: false });
    expect(native.mock.calls.map(([path]) => path)).toEqual([target.resolvedPath]);
  });

  test("invalid traversal hints are not sent to either resolver", async () => {
    const checked: string[] = [];
    const plan = await planFileOpen(file(FILE, { pathHints: ["../outside.csv", "~/../outside.csv", "docs/../../outside.csv"] }), {
      origin: "local", workspaceRoot: ROOT, homeDir: HOME, canOpenLocally: true,
      findInWorkspace: async (candidate) => { checked.push(candidate.value); return null; },
      findOnComputer: async (path) => { checked.push(path); return null; },
    });
    expect(plan.kind).toBe("unavailable");
    expect(checked).toEqual([FILE, `${ROOT}/${FILE}`]);
  });
});

function tool(toolName: string, input: unknown, output: unknown = {}): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName, toolCallId: `${toolName}:${JSON.stringify(input)}`, state: "output-available", input, output };
}
function messages(...parts: UIMessage["parts"]): UIMessage[] {
  return [{ id: "assistant", role: "assistant", parts }];
}

describe("deriveSessionFileEvidence", () => {
  test("collects successful reads and writes from exact structured paths, nested results and patches", () => {
    const evidence = deriveSessionFileEvidence(messages(
      tool("functions.read", { path: `${ABS_DIRECTORY}source notes.md` }),
      tool("write", { filePath: `${ABS_DIRECTORY}résumé 模型.csv` }, { result: { path: `${ABS_DIRECTORY}generated.csv` } }),
      tool("edit", { filepath: `${ROOT}/edited.ts` }),
      tool("apply_patch", { patchText: `*** Begin Patch\n*** Add File: ${ROOT}/new.md\n+New\n*** Update File: ${ROOT}/old.md\n*** Move to: ${ROOT}/moved.md\n*** End Patch` }),
    ));
    expect(evidence.map((target) => target.value).sort()).toEqual([
      `${ABS_DIRECTORY}source notes.md`, `${ABS_DIRECTORY}résumé 模型.csv`, `${ABS_DIRECTORY}generated.csv`,
      `${ROOT}/edited.ts`, `${ROOT}/new.md`, `${ROOT}/old.md`, `${ROOT}/moved.md`,
    ].sort());
    expect(evidence.every((target) => target.kind === "file" && target.exists === undefined && target.fileScope === undefined)).toBe(true);
  });

  test("ignores discovery tools, failed and unfinished calls, ordinary prose and unstructured outputs", () => {
    const failed: DynamicToolUIPart = { type: "dynamic-tool", toolName: "read", toolCallId: "failed", state: "output-error", input: { path: `${ROOT}/failed.md` }, errorText: "Not found" };
    const pending: DynamicToolUIPart = { type: "dynamic-tool", toolName: "write", toolCallId: "pending", state: "input-available", input: { path: `${ROOT}/pending.md` } };
    expect(deriveSessionFileEvidence(messages(
      ...["glob", "grep", "search", "find", "functions.glob"].map((name) => tool(name, { path: `${ROOT}/discovery.md` }, { files: [`${ROOT}/discovered.md`] })),
      failed, pending,
      { type: "text", text: `Saved ${ROOT}/prose.md and \`${ROOT}/inline.md\`` },
      tool("shell", { command: `cat ${ROOT}/command.md` }, `Read ${ROOT}/output.md`),
    ))).toEqual([]);
  });

  test("tool results reporting an error are not successful file evidence", () => {
    expect(deriveSessionFileEvidence(messages(
      tool("read", { path: `${ROOT}/missing.md` }, { error: { type: "not_found", message: "Missing file" } }),
      { ...tool("read", { path: `${ROOT}/denied.md` }), callProviderMetadata: { openwork: { mcpResult: { isError: true, content: [] } } } },
    ))).toEqual([]);
  });

  test("actual file destination metadata wins over the originally requested path", () => {
    expect(deriveSessionFileEvidence(messages({
      ...tool("write", { filePath: "report.md" }),
      callProviderMetadata: { openwork: { fileDestination: `${ABS_DIRECTORY}report.md` } },
    })).map((target) => target.value)).toEqual([`${ABS_DIRECTORY}report.md`]);
    expect(deriveSessionFileEvidence(messages({
      ...tool("edit", { filePath: "/report.md" }),
      callProviderMetadata: { openwork: { workspacePaths: [{ requested: "/report.md", resolved: `${ROOT}/workspaces/real/report.md` }] } },
    })).map((target) => target.value)).toEqual([`${ROOT}/workspaces/real/report.md`]);
  });

  test("deduplicates touched paths and excludes invalid traversal and network shares", () => {
    const evidence = deriveSessionFileEvidence(messages(
      tool("read", { path: `${ABS_DIRECTORY}${FILE}` }),
      tool("write", { path: `${ABS_DIRECTORY}${FILE}` }, { path: `${ABS_DIRECTORY}${FILE}` }),
      tool("read", { files: ["../outside.csv", "~/../outside.csv", "//server/share.csv"] }),
    ));
    expect(evidence.map((target) => target.value)).toEqual([`${ABS_DIRECTORY}${FILE}`]);
  });
});

test("a reply shows an image the chat saved on this computer instead of a broken picture", async () => {
  const path = "~/Downloads/OpenWork/ses_1/Dolores Park postcard.png";
  const invokeDesktop = mock(async (command: string, input: { sessionId: string; path: string }) => {
    if (command !== "computerChatImage") throw new Error(`unexpected ${command}`);
    return input.path === path ? { data: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" } : null;
  });
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop });
  try {
    await act(async () => root?.render(
      <PlatformProvider value={createDefaultPlatform()}>
        <OpenTargetProvider workspaceRoot={ROOT} sessionId="ses_1" openTargets={[]} onOpenTarget={() => {}}>
          <MarkdownBlock text={`Here it is:\n\n![Dolores Park postcard](<${path}>)`} />
        </OpenTargetProvider>
      </PlatformProvider>,
    ));
    const image = required(host.querySelector<HTMLImageElement>("img[data-openwork-image-path]"));
    // The file reference shows while the image loads.
    expect(host.querySelector("[data-openwork-image-fallback] [data-openwork-link-href]")).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(invokeDesktop).toHaveBeenCalledWith("computerChatImage", { sessionId: "ses_1", path });
    expect(image.src.startsWith("blob:")).toBe(true);
    await act(async () => { image.dispatchEvent(new window.Event("load")); });
    expect(host.querySelector("[data-openwork-image]")).toBeNull();
    expect(host.querySelector("[data-openwork-image-preview] img")).toBe(image);
    expect(host.querySelector("[data-openwork-image-fallback]")).toBeNull();
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  }
});

test("an image the chat cannot load stays a clickable file reference", async () => {
  await render("![missing](</Users/test/elsewhere/missing.png>)", () => {});
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(host.querySelector("[data-openwork-image-preview]")?.closest("[hidden]")).not.toBeNull();
  expect(host.querySelector("[data-openwork-image-fallback] [data-openwork-link-href]")).not.toBeNull();
});
