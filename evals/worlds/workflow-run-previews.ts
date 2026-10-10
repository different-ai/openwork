import { evaluateOnSurface, type Surface } from "@openwork/cdp";

// Fixed, read-only witness: probe.dom exposes geometry, not computed colors or
// contrast. Measure the real plan gate; never inject styles or a plan response.
export function enterprisePlanNoticeMeasurements(surface: Surface) {
  return evaluateOnSurface(surface, () => {
    const gate = document.querySelector<HTMLElement>('[data-testid="enterprise-plan-notice"]');
    const notice = gate?.querySelector<HTMLElement>('[data-notice-tone]');
    const state = gate?.querySelector<HTMLElement>('[data-testid="enterprise-plan-notice-state"]');
    const detail = gate?.querySelector<HTMLElement>('[data-testid="enterprise-plan-notice-detail"]');
    const guidance = gate?.querySelector<HTMLElement>('[data-testid="enterprise-plan-notice-guidance"]');
    const lock = gate?.querySelector<SVGElement>("svg.lucide-lock");
    const action = gate?.querySelector<HTMLAnchorElement>("a");
    if (!gate || !notice || !state || !detail || !guidance || !lock || !action) throw new Error("The real plan lock has not rendered.");

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true });
    if (!paint) throw new Error("Could not measure plan-lock colors.");
    const color = (value: string) => {
      if (!CSS.supports("color", value)) throw new Error(`Unmeasurable plan-lock color: ${value}`);
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = value;
      paint.fillRect(0, 0, 1, 1);
      const pixels = paint.getImageData(0, 0, 1, 1).data;
      return { red: pixels[0] ?? 0, green: pixels[1] ?? 0, blue: pixels[2] ?? 0, alpha: (pixels[3] ?? 0) / 255 };
    };
    const sameColor = (left: string, right: string) => JSON.stringify(color(left)) === JSON.stringify(color(right));
    const luminance = (fill: ReturnType<typeof color>) => {
      const linear = (channel: number) => {
        const srgb = channel / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(fill.red) + 0.7152 * linear(fill.green) + 0.0722 * linear(fill.blue);
    };
    const read = (element: Element, token: string) => {
      const style = getComputedStyle(element);
      const ink = color(style.color);
      if (ink.alpha !== 1) throw new Error("Plan-lock ink must be opaque.");
      let backdrop: ReturnType<typeof color> | null = null;
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        const ancestor = getComputedStyle(parent);
        if (Number(ancestor.opacity) !== 1 || ancestor.backgroundImage !== "none") throw new Error("Plan-lock contrast needs fully opaque ancestors without gradients.");
        const fill = color(ancestor.backgroundColor);
        if (fill.alpha !== 0 && fill.alpha !== 1) throw new Error("Plan-lock contrast needs an opaque page background.");
        if (!backdrop && fill.alpha === 1) backdrop = fill;
      }
      if (!backdrop) throw new Error("The plan lock has no measurable page background.");
      const foreground = luminance(ink);
      const background = luminance(backdrop);
      return {
        text: element.textContent?.trim() ?? "",
        color: style.color,
        neutral: sameColor(style.color, style.getPropertyValue(token).trim()),
        contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      };
    };
    return {
      text: gate.textContent?.replace(/\s+/g, " ").trim() ?? "",
      state: read(state, "--dls-text-primary"),
      detail: read(detail, "--dls-text-secondary"),
      guidance: read(guidance, "--dls-text-secondary"),
      guidanceCount: gate.querySelectorAll('[data-testid="enterprise-plan-notice-guidance"]').length,
      lock: read(lock, "--dls-text-secondary"),
      lockCount: gate.querySelectorAll("svg.lucide-lock").length,
      lockHiddenFromAssistiveTech: lock.getAttribute("aria-hidden") === "true",
      tone: notice.dataset.noticeTone,
      role: notice.getAttribute("role"),
      panelPaint: [gate, notice].map((element) => color(getComputedStyle(element).backgroundColor).alpha),
      paragraphCount: gate.querySelectorAll("p").length,
      height: notice.getBoundingClientRect().height,
      action: { label: action.textContent?.trim() ?? "", href: action.getAttribute("href"), target: action.target, rel: action.rel },
    };
  });
}
