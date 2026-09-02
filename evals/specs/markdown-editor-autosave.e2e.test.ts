import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import { markdownArtifact } from "../worlds/chat.ts";

const activeArtifactPath = "artifacts/overflow-tab-12.md";
const untouchedArtifactPath = "artifacts/overflow-tab-11.md";
const typedSentence = "Autosaved without buttons.";

const test = spec.world(markdownArtifact);

async function readFile(probe: Probe, workspaceId: string, path: string): Promise<string> {
  // TODO(primitive): read a workspace file through the local desktop gateway.
  const value = await probe.eval(`(workspaceId, path) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "";
    const request = new XMLHttpRequest();
    request.open("GET", "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/content?path=" + encodeURIComponent(path), false);
    request.setRequestHeader("Authorization", "Bearer " + token);
    request.send();
    if (request.status < 200 || request.status >= 300) return "";
    const json = JSON.parse(request.responseText);
    return typeof json.content === "string" ? json.content : "";
  }`, { args: [workspaceId, path] });
  if (typeof value !== "string") throw new Error(`Workspace file ${path} was not text.`);
  return value;
}

async function waitForFile(probe: Probe, workspaceId: string, path: string, predicate: (value: string) => boolean) {
  return probe.eventually(
    () => readFile(probe, workspaceId, path),
    { within: 15_000, intervalMs: 250, label: `${path} content`, until: predicate },
  );
}

test("markdown artifacts autosave without Save/Discard buttons and format from the right-click menu", async ({ world, user, seed, probe, step }) => {
  await user.see({ text: /Overflow tab 12/ });
  await user.click({ role: "button", text: "Edit" });
  await user.see({ text: /# Overflow tab 12/ });
  await step("the editor header omits manual save controls and byte count", async () => {
    await user.notSee({ role: "button", text: "Save" });
    await user.notSee({ role: "button", text: "Saving" });
    await user.notSee({ role: "button", text: "Discard" });
    expect(await probe.text()).not.toMatch(/\d+(\.\d+)?\s*(bytes|KB|MB|GB|TB)/);
  });

  const baseline = await waitForFile(probe, world.workspace.workspaceId, activeArtifactPath, (content) => content.startsWith("# Overflow tab 12"));
  const untouchedBaseline = await waitForFile(probe, world.workspace.workspaceId, untouchedArtifactPath, (content) => content.startsWith("# Overflow tab 11"));

  await step("typing autosaves to only the active artifact", async () => {
    await user.type({ text: /# Overflow tab 12/ }, `\n\n${typedSentence}`);
    const savedContent = await waitForFile(probe, world.workspace.workspaceId, activeArtifactPath, (content) => content.includes(typedSentence));
    expect(savedContent).toBe(`${baseline}\n${typedSentence}`);
    await user.see({ text: "Saved" });
    expect(await readFile(probe, world.workspace.workspaceId, untouchedArtifactPath)).toBe(untouchedBaseline);
  });

  await step("the context menu formats and autosaves the current line", async () => {
    await user.click({ text: /# Overflow tab 12/ });
    await user.press("Home");
    // TODO(primitive): open a context menu with a trusted right click.
    const contextOpened = await seed.evalIn(world.app, `(() => {
      const target = document.querySelector(".cm-line");
      if (!(target instanceof HTMLElement)) return false;
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 20, clientY: 20 }));
      return true;
    })()`);
    expect(contextOpened).toBe(true);
    for (const item of ["Heading 1", "Heading 2", "Heading 3", "Bold", "Bullet list", "Quote"]) {
      await user.see({ role: "menuitem", text: item });
    }
    await user.looks([
      "A markdown editor is open with a right-click context menu offering Heading 1, Heading 2, Heading 3 and other formatting options",
      "The editor header shows a Saved status label and contains no button labelled Save or Discard",
      "No error dialog or crash message is visible",
    ]);
    await user.click({ role: "menuitem", text: "Heading 2" });

    const headingContent = await waitForFile(probe, world.workspace.workspaceId, activeArtifactPath, (content) => content.startsWith("## Overflow tab 12"));
    expect(headingContent).toBe(`#${baseline}\n${typedSentence}`);
    expect(await readFile(probe, world.workspace.workspaceId, untouchedArtifactPath)).toBe(untouchedBaseline);
  });
});
