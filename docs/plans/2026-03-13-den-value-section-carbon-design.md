# Den Value Section Carbon CTA Design

**Goal:** Bring the Den pricing/value section into visual parity with the Den hero CTA system by using OpenWork's black/carbon palette, rounded pill CTAs, and cleaner responsive spacing.

## Approved Scope

- Keep the existing pricing section structure and copy.
- Replace the bespoke CTA treatments in the value cards with the same rounded CTA language used in the hero.
- Remove the blue featured-card accent language from the Den worker card and use black/carbon gray instead.
- Add small responsive polish so the two cards read cleanly on desktop and stack cleanly on mobile.
- Follow through on the same carbon treatment for the `What you get` icon badges and the `4. Review & Merge` step badge.

## Layout

Desktop:

```text
+----------------------------------------------------------------+
| Pricing copy          | [ Human repetitive work ] [ Den worker ]
|                       |   neutral pill button     carbon pill CTA|
|                       |   gray accents            carbon accents  |
+----------------------------------------------------------------+
```

Mobile:

```text
+------------------------+
| Pricing copy           |
| [ Human card ]         |
| [ Den card ]           |
| full-width pill CTAs   |
| tighter spacing        |
+------------------------+
```

## Visual Direction

- Primary CTA: reuse the shared `doc-button` style so the worker CTA matches the hero exactly.
- Secondary CTA: use a neutral white/carbon rounded pill treatment that sits naturally next to the primary CTA.
- Featured card: remove saturated blue fills, rings, and bullets. Replace them with carbon gradients, charcoal borders, and subtle shadow contrast.
- Capability badges: use soft gray badge fills with carbon icon strokes so the carousel no longer introduces a separate blue system.
- Workflow steps: keep step 1 blue as the intentional setup accent, but move step 4 to the same neutral carbon badge language.
- Responsive polish: prevent narrow text and CTA wrapping issues with slightly tighter gaps, full-width buttons, and card content that fills the available height without depending on desktop spacing.

## Verification

- Run the landing page locally and verify `/den` in desktop and mobile widths.
- Capture before/after screenshots of the value section for the PR.
- Use real-page verification rather than adding a new test harness for this styling-only landing change.
