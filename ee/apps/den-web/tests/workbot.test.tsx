import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { WorkbotMarkdown } from "../app/(den)/workbot/_components/workbot-markdown";
import { dayLabel, durationLabel, fileTitle, initials, scheduleLabel } from "../app/(den)/workbot/_components/workbot-format";

describe("Workbot answers", () => {
  const render = (text: string) => renderToStaticMarkup(createElement(WorkbotMarkdown, { text }));

  test("render Markdown as elements", () => {
    const markup = render("**Foundry Loft** is under budget.\n\n- Room for 40\n- Free Oct 15–16\n\n| Venue | Price |\n|---|---|\n| Loft | $140 |");
    expect(markup).toContain("<strong");
    expect(markup).toContain("<li>");
    expect(markup).toContain("<table");
  });

  test("never inject HTML or unsafe links from model output", () => {
    const markup = render('<img src=x onerror="alert(1)"> [open](javascript:alert(1)) [site](https://example.com)');
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain('href="https://example.com/"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });
});

describe("Workbot wording", () => {
  test("schedules read the way a person says them", () => {
    expect(scheduleLabel({ kind: "weekly", timezone: "UTC", daysOfWeek: [1], hour: 8, minute: 0 })).toBe("Every Monday at 8:00 AM");
    expect(scheduleLabel({ kind: "weekly", timezone: "UTC", daysOfWeek: [5, 1], hour: 16, minute: 30 })).toBe("Mondays and Fridays at 4:30 PM");
    expect(scheduleLabel({ kind: "weekly", timezone: "UTC", daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe("Every weekday at 9:00 AM");
    expect(scheduleLabel({ kind: "daily", timezone: "UTC", hour: 0, minute: 5 })).toBe("Every day at 12:05 AM");
  });

  test("durations, days, drafts and initials", () => {
    expect(durationLabel(130_000)).toBe("2m 10s");
    expect(durationLabel(400)).toBe("1s");
    const now = new Date(2026, 8, 30, 15).getTime();
    expect(dayLabel(new Date(2026, 8, 30, 9).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 29, 9).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 25, 9).getTime(), now)).toBe("Friday");
    expect(fileTitle("drafts/launch-pricing-copy.md")).toBe("Launch pricing copy");
    expect(initials("Maya Rodriguez")).toBe("MR");
    expect(initials(null)).toBe("?");
  });
});
