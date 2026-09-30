import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DenListRow } from "../app/(den)/_components/ui/list-row";
import { DenNotice } from "../app/(den)/_components/ui/notice";
import { DenOptionCard } from "../app/(den)/_components/ui/option-card";
import { DenToggleRow } from "../app/(den)/_components/ui/toggle-row";

describe("Den neutral state surfaces", () => {
  test("keeps warning notices neutral while retaining a compact warning cue", () => {
    const markup = renderToStaticMarkup(<DenNotice tone="warning" message="Review this setting." />);

    expect(markup).toContain("border-[var(--dls-border)]");
    expect(markup).toContain("bg-[var(--dls-hover)]");
    expect(markup).toContain("text-[var(--ow-warning)]");
    expect(markup).not.toContain("border-amber");
    expect(markup).not.toContain("bg-amber");
  });

  test("uses neutral fill and hairlines for selected cards and rows", () => {
    const option = renderToStaticMarkup(
      <DenOptionCard
        type="radio"
        name="mode"
        checked
        onChange={() => undefined}
        title="Selected option"
      />,
    );
    const toggle = renderToStaticMarkup(
      <DenToggleRow
        title="Selected toggle"
        checked
        onChange={() => undefined}
      />,
    );
    const warningRow = renderToStaticMarkup(<DenListRow tone="warning" title="Needs attention" />);

    for (const markup of [option, toggle]) {
      expect(markup).toContain("border-[var(--dls-border)]");
      expect(markup).toContain("bg-[var(--dls-active)]");
      expect(markup).not.toContain("border-gray-900");
    }
    expect(warningRow).toContain("bg-[var(--dls-hover)]");
    expect(warningRow).not.toContain("bg-amber");
  });
});
