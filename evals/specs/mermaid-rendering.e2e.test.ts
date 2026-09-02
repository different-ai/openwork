import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { arrangeControl, mermaidChat } from "../worlds/chat.ts";

const test = spec.world(mermaidChat);

test("Mermaid renders safely in completed chat and Markdown artifacts", async ({ world, user, seed, probe, step }) => {
  await user.see({ text: "Mermaid diagram", nth: 0 });

  await step("completed chat diagrams render or fall back safely", async () => {
    // TODO(primitive): read Mermaid rendering states and safety reasons.
    const chatContract = await probe.eval(`(() => {
      const diagrams = [...document.querySelectorAll("[data-openwork-mermaid]")];
      const find = (text) => diagrams.find((diagram) => diagram.querySelector("[data-openwork-mermaid-source]")?.textContent?.includes(text));
      const valid = find("Inline Mermaid Start");
      const remote = find("No remote resources");
      const malformed = find("not-a-mermaid-diagram");
      const guarded = find("Guard node 250");
      const sourceVisible = (diagram) => diagram?.querySelector("[data-openwork-mermaid-source]")?.hidden === false;
      return {
        count: diagrams.length,
        settled: diagrams.every((diagram) => diagram.getAttribute("aria-busy") === "false"),
        validRendered: valid?.dataset.openworkMermaidState === "rendered" && Boolean(valid.querySelector("svg")),
        controls: Boolean(valid?.querySelector("[data-openwork-mermaid-view='source']") && valid.querySelector("[data-openwork-mermaid-view='rendered']") && valid.querySelector("[data-openwork-mermaid-download]:not([hidden])")),
        unsafeFallback: remote?.dataset.openworkMermaidReason === "unsafe" && sourceVisible(remote) && !remote.querySelector("svg"),
        malformedFallback: malformed?.dataset.openworkMermaidReason === "invalid" && sourceVisible(malformed) && !malformed.querySelector("svg"),
        guardFallback: guarded?.dataset.openworkMermaidReason === "complexity" && sourceVisible(guarded) && !guarded.querySelector("svg"),
        lightTheme: valid?.dataset.openworkMermaidTheme === "light",
      };
    })()`);
    expect(chatContract).toEqual({
      count: 4,
      settled: true,
      validRendered: true,
      controls: true,
      unsafeFallback: true,
      malformedFallback: true,
      guardFallback: true,
      lightTheme: true,
    });
  });

  await step("rendered and source views toggle", async () => {
    await user.click({ role: "button", text: "Source", nth: 0 });
    // TODO(primitive): read a Mermaid diagram's selected view.
    expect(await probe.eval(`document.querySelector("[data-openwork-mermaid]")?.getAttribute("data-openwork-mermaid-state")`)).toBe("source");
    await user.click({ role: "button", text: "Rendered", nth: 0 });
    // TODO(primitive): read a Mermaid diagram's selected view.
    expect(await probe.eval(`document.querySelector("[data-openwork-mermaid]")?.getAttribute("data-openwork-mermaid-state")`)).toBe("rendered");
  });

  await step("the rendered diagram downloads as SVG", async () => {
    // TODO(primitive): install a download witness for a user-initiated browser download.
    await seed.evalIn(world.app, `(() => {
      globalThis.__mermaidDownloadObserved = false;
      document.addEventListener("click", (event) => {
        if (!(event.target instanceof HTMLAnchorElement) || !event.target.download.endsWith(".svg")) return;
        event.preventDefault();
        globalThis.__mermaidDownloadObserved = event.target.href.startsWith("blob:");
      }, { capture: true });
      return true;
    })()`);
    await user.click({ role: "button", label: "Download diagram as SVG", nth: 0 });
    // TODO(primitive): read whether a browser download witness observed the generated SVG.
    expect(await probe.eval(`globalThis.__mermaidDownloadObserved === true`)).toBe(true);
  });

  await step("theme rerender preserves the selected source view", async () => {
    await arrangeControl(seed, world.app, "eval.mermaid.set_theme", { mode: "dark" });
    await user.click({ role: "button", text: "Source", nth: 0 });
    // TODO(primitive): read theme and selected-view state from a rendered diagram.
    expect(await probe.eval(`(() => {
      const diagram = document.querySelector("[data-openwork-mermaid]");
      return document.documentElement.dataset.theme === "dark"
        && diagram?.getAttribute("data-openwork-mermaid-theme") === "dark"
        && diagram?.getAttribute("data-openwork-mermaid-state") === "source";
    })()`)).toBe(true);
  });

  await step("fenced Mermaid renders in a Markdown artifact", async () => {
    try {
      await arrangeControl(seed, world.app, "browser.open_url", { url: "about:blank" });
    } catch {
      // The browser can report ERR_ABORTED after it has already mounted the artifact side panel.
    }
    await arrangeControl(seed, world.app, "eval.markdown_primitive.seed_artifact");
    await user.click({ role: "button", text: /markdown-primitive-proof\.md/ });
    // TODO(primitive): inspect Mermaid rendering inside a Markdown artifact preview.
    expect(await probe.eval(`Boolean(document.querySelector("[data-openwork-markdown-preview] [data-openwork-mermaid-state='rendered'] svg"))
      && document.querySelector("[data-openwork-markdown-preview] [data-openwork-mermaid-source]")?.textContent?.includes("Artifact Mermaid Start")`)).toBe(true);
  });

  await step("standalone Mermaid renders with artifact actions", async () => {
    await arrangeControl(seed, world.app, "eval.markdown_primitive.seed_artifact", { standalone: true });
    await user.click({ role: "button", text: /standalone-mermaid-proof\.mmd/ });
    await user.see({ role: "button", text: "Edit" });
    // TODO(primitive): inspect a standalone Mermaid artifact rendering.
    expect(await probe.eval(`Boolean(document.querySelector("[data-openwork-mermaid-artifact] [data-openwork-mermaid-state='rendered'] svg"))`)).toBe(true);
    await user.click({ role: "button", label: "Artifact actions" });
    await user.see({ role: "menuitem", text: "Download" });
  });
});
