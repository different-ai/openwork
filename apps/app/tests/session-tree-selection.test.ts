import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { SELECTION_QUOTE_MAX_CHARS, appendQuoteToDraft, quoteForDraft, replySelection } = await import("../src/react-app/domains/session/links/selection-quote");
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

describe("selected text becomes a quote in the side chat's draft", () => {
  test("each line is quoted and the caret lands under it", () => {
    expect(quoteForDraft("  first line\n\nsecond line  ")).toBe("> first line\n>\n> second line\n\n");
    expect(quoteForDraft("   ")).toBe("");
  });

  test("a very long selection is cut, and text already drafted is kept above the quote", () => {
    const quote = quoteForDraft("x".repeat(SELECTION_QUOTE_MAX_CHARS + 10));
    expect(quote).toBe(`> ${"x".repeat(SELECTION_QUOTE_MAX_CHARS)}…\n\n`);
    expect(appendQuoteToDraft("", "picked")).toBe("> picked\n\n");
    expect(appendQuoteToDraft("Why is this slow?\n", "picked")).toBe("Why is this slow?\n\n> picked\n\n");
    expect(appendQuoteToDraft("kept", "  ")).toBe("kept");
  });
});

describe("which selections offer a side chat", () => {
  document.body.innerHTML = `
    <div id="pane">
      <div data-message-role="user"><p id="mine">My own question</p></div>
      <div data-message-role="assistant"><p id="one">First reply paragraph</p><p id="two">Second paragraph</p></div>
      <div data-message-role="assistant"><p id="other">Another reply</p></div>
    </div>
    <div id="elsewhere"><div data-message-role="assistant"><p id="outside">Reply in another pane</p></div></div>`;
  const pane = document.getElementById("pane")!;
  const select = (startId: string, endId: string) => {
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(document.getElementById(startId)!.firstChild!, 0);
    const end = document.getElementById(endId)!.firstChild!;
    range.setEnd(end, end.textContent!.length);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  };

  test("text inside one reply, even across its paragraphs", () => {
    expect(replySelection(select("one", "one"), pane)?.text).toBe("First reply paragraph");
    expect(replySelection(select("one", "two"), pane)?.text).toContain("Second paragraph");
  });

  test("not the person's own message, a selection spanning two replies, another pane, or nothing", () => {
    expect(replySelection(select("mine", "mine"), pane)).toBeNull();
    expect(replySelection(select("two", "other"), pane)).toBeNull();
    expect(replySelection(select("outside", "outside"), pane)).toBeNull();
    document.getSelection()!.removeAllRanges();
    expect(replySelection(document.getSelection(), pane)).toBeNull();
    expect(replySelection(null, pane)).toBeNull();
  });
});
