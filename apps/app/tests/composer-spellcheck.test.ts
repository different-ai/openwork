import { afterEach, beforeEach, describe, expect, test } from "bun:test";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

class FakeHTMLElement {
  spellcheck = true;
  private attrs = new Map<string, string>();

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (name === "spellcheck") {
      this.spellcheck = value === "true";
    }
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
}

const originalWindow = globalThis.window;
const originalHTMLElement = globalThis.HTMLElement;

const {
  applySpellcheckToEditableRoot,
  readComposerSpellcheckEnabled,
  writeComposerSpellcheckEnabled,
} = await import("../src/react-app/domains/session/surface/composer/spellcheck");

describe("composer spellcheck preference", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: memoryStorage() },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("defaults to disabled", () => {
    writeComposerSpellcheckEnabled(false);
    expect(readComposerSpellcheckEnabled()).toBe(false);
  });

  test("persists enabled preference", () => {
    writeComposerSpellcheckEnabled(true);
    expect(readComposerSpellcheckEnabled()).toBe(true);
    writeComposerSpellcheckEnabled(false);
  });
});

describe("applySpellcheckToEditableRoot", () => {
  beforeEach(() => {
    globalThis.HTMLElement = FakeHTMLElement as typeof HTMLElement;
  });

  afterEach(() => {
    globalThis.HTMLElement = originalHTMLElement;
  });

  test("updates contenteditable and textarea elements", () => {
    const editor = new FakeHTMLElement();
    editor.setAttribute("contenteditable", "true");
    const textarea = new FakeHTMLElement();
    const root = {
      querySelectorAll: () => [editor, textarea],
    };

    applySpellcheckToEditableRoot(root, false);
    expect(editor.getAttribute("spellcheck")).toBe("false");
    expect(editor.spellcheck).toBe(false);
    expect(textarea.getAttribute("spellcheck")).toBe("false");
    expect(textarea.spellcheck).toBe(false);

    applySpellcheckToEditableRoot(root, true);
    expect(editor.getAttribute("spellcheck")).toBe("true");
    expect(editor.spellcheck).toBe(true);
  });
});
