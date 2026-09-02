import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, seedSessions, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "expanded tool groups reveal full commands, search patterns, and errors on click"
  : "chat tool details expand skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

// Tails of the seeded values (see eval.tool_details.seed). Each is well past the
// old clip points (44-char pattern cap, 120-char error first line, one-line
// command box), so seeing it proves the whole value is readable.
const COMMAND_TAIL = "chat-loading-shimmer.e2e.test.ts --reporter=verbose";
const PATTERN_TAIL = "createSessionLifecycleEvalMessages|useControlAction";
const ERROR_TAIL = "hint: use 'git fetch origin release/2026.09' first";

type DetailKind = "command" | "pattern" | "error";

type DetailProbe = {
  kind: string;
  expanded: string | null;
  ariaLabel: string | null;
  isButton: boolean;
  visibleLines: number;
  clipped: boolean;
  text: string;
};

function isDetailProbe(value: unknown): value is DetailProbe {
  return typeof value === "object" && value !== null && "kind" in value && "text" in value && "visibleLines" in value;
}

// Longest detail box of the requested kind (the seed's failed row also has a
// short command box; the long one is what the claims are about).
const probeScript = (kind: DetailKind, click: boolean) => `(() => {
  const boxes = [...document.querySelectorAll('[data-tool-aggregate-detail="${kind}"]')];
  const box = boxes
    .map((el) => ({ el, len: (el.querySelector('code')?.textContent ?? '').length }))
    .sort((a, b) => b.len - a.len)[0]?.el;
  if (!box) return null;
  if (${click}) box.click();
  const code = box.querySelector('code');
  if (!code) return null;
  const lineHeight = parseFloat(getComputedStyle(code).lineHeight) || 20;
  return {
    kind: box.getAttribute('data-tool-aggregate-detail'),
    expanded: box.getAttribute('data-command-expanded'),
    ariaLabel: box.getAttribute('aria-label'),
    isButton: box.tagName === 'BUTTON',
    visibleLines: Math.round(code.getBoundingClientRect().height / lineHeight),
    clipped: code.scrollHeight > code.clientHeight + 1 || code.scrollWidth > code.clientWidth + 1,
    text: code.textContent ?? '',
  };
})()`;

async function probe(app: Awaited<ReturnType<typeof desktop>>, kind: DetailKind, click: boolean): Promise<DetailProbe> {
  if (click) {
    // Let React commit the toggle before measuring.
    await evalIn(app, probeScript(kind, true));
    await waitFor(app, `document.querySelector('[data-tool-aggregate-detail="${kind}"]') !== null`, {
      timeoutMs: 5_000,
      label: `${kind} detail box still mounted`,
    });
  }
  const result = await evalIn(app, probeScript(kind, false));
  if (!isDetailProbe(result)) {
    throw new Error(`${kind} detail box was not readable: ${JSON.stringify(result)}`);
  }
  return result;
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "chat-tool-details-expand" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-chat-tool-details-${Date.now()}`,
  });
  await seedSessions(app, ["Tool details proof"]);
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.tool_details.seed" && !action.disabled)`,
    { timeoutMs: 30_000, label: "tool details seed control ready" },
  );
  await control(app, "eval.tool_details.seed");

  await waitFor(app, `Boolean(document.querySelector('[data-tool-aggregate] > button'))`, {
    timeoutMs: 15_000,
    label: "aggregate group header",
  });
  const opened = await evalIn(app, `(() => {
    const trigger = document.querySelector('[data-tool-aggregate] > button');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    return true;
  })()`);
  expect(opened).toBe(true);
  await waitFor(app, `document.querySelectorAll('[data-tool-aggregate-detail]').length >= 4`, {
    timeoutMs: 15_000,
    label: "expanded rows with detail boxes",
  });

  // The search row names its scope in prose and does not clip the pattern in JS.
  const searchLabel = await evalIn(app, `(() => {
    const box = document.querySelector('[data-tool-aggregate-detail="pattern"]');
    const row = box?.parentElement;
    return row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  if (typeof searchLabel !== "string") throw new Error(`Search row was not readable: ${JSON.stringify(searchLabel)}`);
  expect(searchLabel).toContain("Searched code in apps/app/src · *.tsx");
  expect(searchLabel).not.toContain("Searching for");
  expect(searchLabel).not.toContain("...");
  evidence.recordAssertionEvidence(
    "A finished search row reads in past tense and names its path and include scope",
    `Row text was “${searchLabel}”; it contained no in-flight “Searching for” label and no JS “...” clip.`,
    true,
  );

  const cases: { kind: DetailKind; tail: string; noun: string }[] = [
    { kind: "command", tail: COMMAND_TAIL, noun: "command" },
    { kind: "pattern", tail: PATTERN_TAIL, noun: "search pattern" },
    { kind: "error", tail: ERROR_TAIL, noun: "error" },
  ];

  for (const { kind, tail, noun } of cases) {
    const collapsed = await probe(app, kind, false);
    expect(collapsed.isButton).toBe(true);
    expect(collapsed.expanded).toBe("false");
    expect(collapsed.ariaLabel).toBe(`Show full ${noun}`);
    expect(collapsed.visibleLines).toBe(1);
    expect(collapsed.clipped).toBe(true);
    // The full value is in the DOM even while collapsed — nothing was cut in JS.
    expect(collapsed.text).toContain(tail);

    const expanded = await probe(app, kind, true);
    expect(expanded.expanded).toBe("true");
    expect(expanded.ariaLabel).toBe(`Collapse ${noun}`);
    expect(expanded.visibleLines).toBeGreaterThan(1);
    expect(expanded.clipped).toBe(false);
    expect(expanded.text).toContain(tail);

    const recollapsed = await probe(app, kind, true);
    expect(recollapsed.expanded).toBe("false");
    expect(recollapsed.visibleLines).toBe(1);

    evidence.recordAssertionEvidence(
      `A long ${noun} is one clipped line until clicked, then fully readable, then collapsible again`,
      `Collapsed: 1 visible line, clipped, labelled “Show full ${noun}”. Expanded: ${expanded.visibleLines} lines, not clipped, ending “${tail}”. Re-collapsed to 1 line.`,
      true,
    );
  }

  // Toggles are independent: expanding the error must not expand the command.
  await probe(app, "error", true);
  const command = await probe(app, "command", false);
  const error = await probe(app, "error", false);
  expect(error.expanded).toBe("true");
  expect(command.expanded).toBe("false");
  evidence.recordAssertionEvidence(
    "Each detail box toggles independently of the others in the same group",
    `After expanding the error box, the error read expanded=${error.expanded} while the command box stayed expanded=${command.expanded}.`,
    true,
  );

  // The old clipped-first-line "failed — …" summary is gone.
  const legacyFailedSummary = await evalIn(app, `document.body.innerText.includes('failed — ')`);
  expect(legacyFailedSummary).toBe(false);
});
