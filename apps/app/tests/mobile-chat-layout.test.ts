import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { visualViewportGeometry } from "../src/hooks/use-visual-viewport-inset";
import { mobileTurnSpace } from "../src/react-app/domains/session/surface/mobile-turn-space";
import { hideEmptyHeroIntroduction } from "../src/react-app/domains/session/chat/empty-hero-introduction";

test("mobile introduction returns only after composition exits with an idle empty draft", () => {
  expect(hideEmptyHeroIntroduction(true, true, "", false)).toBe(true);
  expect(hideEmptyHeroIntroduction(true, false, "draft", false)).toBe(true);
  expect(hideEmptyHeroIntroduction(true, false, "", true)).toBe(true);
  expect(hideEmptyHeroIntroduction(true, true, "", true)).toBe(true);
  expect(hideEmptyHeroIntroduction(true, false, "  ", false)).toBe(false);
  expect(hideEmptyHeroIntroduction(false, true, "draft", true)).toBe(false);
});

test("mobile header hides only metadata, and composer exit requires an outside interaction", () => {
  const page = source("react-app/domains/session/chat/session-page.tsx");
  expect(page).toContain('!props.primaryTitle && !props.mainContentTitle && "max-lg:hidden"');
  expect(page).toContain('className="hidden min-w-0 shrink-0 items-center gap-1.5 text-[12px] text-dls-secondary lg:flex"');
  const hero = source("react-app/domains/session/chat/session-empty-hero.tsx");
  expect(hero).toContain('document.addEventListener("pointerdown", leaveComposer)');
  expect(hero).toContain('document.addEventListener("focusin", leaveComposer)');
  expect(hero).not.toContain("onBlur");
  expect(hero).toContain("setSendInFlight(true)");
  expect(hero).toContain("data-empty-greeting hidden={hideIntroduction}");
  expect(hero).toContain("data-empty-suggestions hidden={hideIntroduction}");
});

describe("mobile viewport geometry", () => {
  test("tracks keyboard height and Safari focus pan independently", () => {
    expect(visualViewportGeometry(360.4, 85.6, 1)).toEqual({ height: 360, top: 86 });
    expect(visualViewportGeometry(740, 0, 1)).toEqual({ height: 740, top: 0 });
    expect(visualViewportGeometry(360, -2, 1)).toEqual({ height: 360, top: 0 });
  });
  test("leaves pinch zoom and invalid measurements to the browser", () => {
    expect(visualViewportGeometry(300, 0, 2)).toBeNull();
    expect(visualViewportGeometry(0, 0, 1)).toBeNull();
    expect(visualViewportGeometry(NaN, 0, 1)).toBeNull();
  });
});

describe("new-turn answer space", () => {
  test("is consumed by the answer without moving the prompt", () => {
    expect(mobileTurnSpace(400, 48)).toBe(352);
    expect(mobileTurnSpace(400, 180)).toBe(220);
    expect(mobileTurnSpace(400, 500)).toBe(0);
  });
  test("adapts to keyboard resize and never reserves negative space", () => {
    expect(mobileTurnSpace(240, 180)).toBe(60);
    expect(mobileTurnSpace(600, 180)).toBe(420);
    expect(mobileTurnSpace(240, -1)).toBe(240);
  });
});

// Source contracts assert responsive ownership, not Safari layout or focus behavior.
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
test("only the mobile chat shell owns the visual viewport; composer does not double-inset", () => {
  const page = source("react-app/domains/session/chat/session-page.tsx");
  expect(page).toContain("max-lg:top-[var(--chat-viewport-top,0px)]");
  expect(page).toContain("max-lg:h-[var(--chat-viewport-height,100dvh)]");
  const composer = source("react-app/domains/session/surface/composer/composer.tsx");
  expect(composer).not.toContain("--keyboard-inset");
  expect(composer).toContain("max-lg:flex @min-[560px]/composer:flex");
  expect(composer).toContain("max-lg:flex-nowrap");
  expect(composer).toContain('event.pointerType === "touch"');
});
test("mobile hero docks the shared composer and desktop retains editor dimensions", () => {
  const hero = source("react-app/domains/session/chat/session-empty-hero.tsx");
  expect(hero).toContain("data-empty-composer-dock");
  expect(hero).toContain("max-lg:order-last max-lg:mt-auto");
  expect(hero).toContain("<NewTaskComposer");
  const editor = source("react-app/domains/session/surface/composer/editor.tsx");
  expect(editor).toContain("min-h-6");
  expect(editor).toContain("lg:min-h-[60px] lg:max-h-[280px]");
  expect(editor).toContain("text-base");
});

test("empty prompt suggestions keep a visible responsive affordance", () => {
  const hero = source("react-app/domains/session/chat/session-empty-hero.tsx");
  // Suggestions are outlined pills that wrap on narrow screens and meet the 44px touch target on phones.
  expect(hero).toContain('data-empty-suggestions hidden={hideIntroduction} className="flex flex-wrap justify-center gap-2"');
  const suggestion = hero.slice(hero.indexOf("{suggestions.map("), hero.indexOf("</Button>)}", hero.indexOf("{suggestions.map(")));
  expect(suggestion).toContain('variant="outline"');
  expect(suggestion).toContain("rounded-full");
  expect(suggestion).toContain("max-lg:min-h-11");
  expect(suggestion).not.toContain('variant="ghost"');
});
