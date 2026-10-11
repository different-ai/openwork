# UI guardrails

`pnpm check:ui-guardrails` runs in the existing **Feature registry, Helm chart
and guard rules** CI job. `pnpm test:ui-guardrails` exercises positive and
negative syntax fixtures and the baseline ratchet.

The TypeScript syntax scan covers shipped JS/TS/JSX/TSX in `apps/app/src`,
`ee/apps/den-web`, and `ee/packages/workbot-ui`, excluding dependencies, build
outputs, tests, fixtures and stories. It catches:

- Raw checkbox inputs and selects; use shared Switch/Checkbox/Select (P5).
- Literal menu/listbox roles with absolute positioning on themselves or a JSX
  ancestor, unless enclosed by a Portal, createPortal, or shared portaled
  SelectContent/DropdownMenuContent/PopoverContent (P5).
- Faint neutral text utilities (gray/slate/zinc/neutral/stone 50–400), and
  foreground/muted-foreground utilities at 50% opacity or less (V1, V2).
  SVG and `*Icon` ink is excluded; other literal class constants are checked
  conservatively because their eventual text role is not statically known.
- Arbitrary text sizes at 10px or less (including rem at the 16px root scale)
  (V1).

This is a syntax guard, not a CSS engine or accessibility/contrast verdict.
Computed utility names, external CSS positioning, portal aliases and arbitrary
colors need design review. Shared portal components must actually portal;
using a familiar component name is not visual proof. The design review skill
also covers fixed-width/clipped surfaces, recovery copy and locked-state owners.

## Ratchet and baseline maintenance

`scripts/ui-guardrails-baseline.json` records existing violations by file,
rule, whitespace-normalized witness hash and occurrence count. Moving lines
is harmless; copying an existing violation or moving it to a new file fails.
Removing violations never requires a refresh. Existing debt is not approval.

To retire fixed entries, or after an intentional scanner rule change:

1. Run `pnpm test:ui-guardrails` and `pnpm check:ui-guardrails` first.
2. Run `node scripts/check-ui-guardrails.mjs --update-baseline`.
3. Review the baseline diff: ordinary repairs should only remove entries.
   Explain new entries introduced by broader detection in the PR. Never
   regenerate the baseline to waive newly written violating UI.
4. Commit the reviewed baseline and rerun both commands.

## Reusable witnesses

`evals/helpers/ui-witnesses.ts` contains read-only surface helpers:

- `preScrollCenterHitTest(surface, selector, index)`: native CDP pointer target
  at the element's measured center, before any see/click can auto-scroll.
- `popupPaintState(surface, popupSelector, triggerSelector)`: computed paint
  and hidden ancestors, retained DOM count, closed/expanded and focused trigger.
  Base UI Select keeps hidden options for typeahead: pair zero painted lists
  with the closed trigger and stable `user.notSee`, not zero DOM nodes.
- `documentOverflow(surface)`: document/body scrollWidth versus measured root
  clientWidth. Classic scrollbars reduce usable width; innerWidth is diagnostic,
  not the overflow limit.

The settings, Calendar and workspace-selection journeys use these helpers
without removing their geometry, pointer, keyboard, focus, saved-state or
stable-absence assertions. Workspace selection retains its atomic DOM center
hit observations alongside clipping ancestors, scroll demand and focused state;
shared paint and usable-width checks add to its existing closure/overflow checks.
They do not change Chrome launch policy or the design measurement collector.
