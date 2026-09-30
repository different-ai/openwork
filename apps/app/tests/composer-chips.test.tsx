import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

import { AttachmentFileChip, ComposerBadgeChip } from "../src/components/chat/composer-pill";
import {
  agentBadge,
  attachmentChipIcon,
  attachmentChipMeta,
  composerPillBadge,
  fileMentionBadge,
  pastedTextBadge,
  renderAttachmentFileChipDom,
  renderComposerBadgeDom,
  type ComposerBadge,
} from "../src/react-app/domains/session/surface/composer/composer-chips";

const ownedDom = typeof document === "undefined";
beforeAll(() => { if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" }); });
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

function shape(root: Element) {
  return [...root.querySelectorAll("*")].filter((element) => element.tagName.toLowerCase() === "span" || element === root)
    .map((element) => ({ className: element.getAttribute("class"), text: element.children.length ? null : element.textContent }));
}

function reactRoot(markup: string) {
  const host = document.createElement("div");
  host.innerHTML = markup;
  const root = host.firstElementChild;
  if (!root) throw new Error("nothing rendered");
  return root;
}

describe("composer chips", () => {
  test("badges share one neutral style; only the icon slot names the kind", () => {
    expect(composerPillBadge({ kind: "skill", name: "release-notes" })).toMatchObject({ label: "Release notes", tone: "violet", slot: { icon: "book" } });
    expect(agentBadge("reviewer")).toMatchObject({ label: "reviewer", tone: "sky", slot: { initial: "R" } });
    expect(fileMentionBadge("docs/plan.md")).toMatchObject({ label: "plan.md", tone: "gray", slot: { icon: "file-text" } });
    expect(pastedTextBadge(42)).toMatchObject({ label: "Pasted text", meta: "42 lines", tone: "gray", slot: { icon: "lines" }, disclosure: true });
    expect(pastedTextBadge(1).meta).toBe("1 line");
  });

  test("file chips show the type and size", () => {
    expect(attachmentChipMeta({ filename: "demo.mp4", mime: "video/mp4", bytes: 19_293_798 })).toBe("MP4 · 18.4 MB");
    expect(attachmentChipMeta({ filename: "notes.pdf", mime: "application/pdf" })).toBe("PDF");
    expect(attachmentChipIcon("demo.mp4", "application/octet-stream")).toBe("file-video");
    expect(attachmentChipIcon("sheet.csv", "")).toBe("file-sheet");
    expect(attachmentChipIcon("blob.bin", "")).toBe("file");
  });

  test("the composer's DOM chips and the sent message's React chips match", () => {
    const badges: ComposerBadge[] = [
      composerPillBadge({ kind: "skill", name: "release" }),
      composerPillBadge({ kind: "computer", target: "cloud" }),
      agentBadge("reviewer"),
      fileMentionBadge("src/app.ts"),
      { ...pastedTextBadge(3), disclosure: false },
    ];
    for (const badge of badges) {
      const dom = document.createElement("span");
      renderComposerBadgeDom(dom, badge);
      const rendered = reactRoot(renderToStaticMarkup(<ComposerBadgeChip badge={badge} />));
      expect(shape(rendered)).toEqual(shape(dom));
    }
    const file = { filename: "demo.mp4", mime: "video/mp4", bytes: 19_293_798 };
    const dom = document.createElement("span");
    renderAttachmentFileChipDom(dom, file);
    const rendered = reactRoot(renderToStaticMarkup(<AttachmentFileChip {...file} />));
    expect(rendered.textContent).toBe(dom.textContent);
    expect(rendered.getAttribute("class")).toBe(dom.getAttribute("class"));
  });
});
