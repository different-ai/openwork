import { callFunctionOnSurface, type Surface } from "@openwork/cdp";

/**
 * Fixed, read-only witness for the shared Den save bar. user.click/user.see
 * can scroll a covered control into view, so read hit targets BEFORE either
 * acts. This never scrolls, focuses, changes a draft, or matches CSS classes.
 */
export function readDenStickyActionBar(surface: Surface, screen: "permissions" | "gateway", switchLabel: string) {
  return callFunctionOnSurface(surface, (screen: "permissions" | "gateway", switchLabel: string) => {
    const bar = document.querySelector('[data-den-action-bar="sticky"]');
    const card = bar?.firstElementChild;
    const main = bar?.closest("main");
    const control = Array.from(main?.querySelectorAll('[role="switch"]') ?? [])
      .find((element) => element.getAttribute("aria-label") === switchLabel);
    const save = main?.querySelector(screen === "permissions"
      ? '[data-testid="permission-set-save-bar"] button:last-child'
      : '[data-testid="gateway-provider-save"]');
    if (!bar || !card || !main || !control || !save) throw new Error(`Missing ${screen} save-bar witness for ${switchLabel}.`);
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const inspect = (element: Element) => {
      const box = rect(element);
      const x = (box.left + box.right) / 2;
      const y = (box.top + box.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        ...box, x, y,
        hitTest: hit !== null && (hit === element || element.contains(hit)),
        focused: document.activeElement === element,
        checked: element.getAttribute("aria-checked"),
        disabled: element.matches(":disabled"),
      };
    };
    const barBox = rect(bar);
    const cardBox = rect(card);
    const controlBox = inspect(control);
    const style = getComputedStyle(bar);
    const gapY = cardBox.bottom + 8;
    const content = Array.from(main.querySelectorAll(screen === "permissions"
      ? '[data-testid="permission-row"]'
      : 'section[aria-labelledby^="gateway-"]'));
    const gap = [controlBox.x, barBox.left + 24, barBox.right - 24].map((x) => {
      const hit = document.elementFromPoint(x, gapY);
      const underneath = content.filter((element) => {
        const box = rect(element);
        return box.left <= x && x <= box.right && box.top <= gapY && gapY <= box.bottom;
      });
      return {
        x, y: gapY,
        coveredByBar: hit !== null && bar.contains(hit),
        hitsFormContent: hit !== null && content.some((element) => element === hit || element.contains(hit)),
        underlyingContent: underneath.map((element) => ({
          text: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) ?? "",
          ...rect(element),
        })),
      };
    });
    return {
      bar: { ...barBox, position: style.position, bottomInset: style.bottom, background: style.backgroundColor, opacity: style.opacity },
      card: cardBox,
      main: { ...rect(main), background: getComputedStyle(main).backgroundColor, scrollPaddingBottom: Number.parseFloat(getComputedStyle(main).scrollPaddingBottom) },
      scroll: { top: main.scrollTop, remaining: main.scrollHeight - main.clientHeight - main.scrollTop, height: main.clientHeight },
      control: controlBox,
      save: inspect(save),
      activeLabel: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? "",
      gap,
    };
  }, [screen, switchLabel]);
}
