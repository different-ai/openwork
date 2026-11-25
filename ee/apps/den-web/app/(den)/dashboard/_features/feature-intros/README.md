# Feature intros (Den web)

Per-page intros: full screen, box or banner, chosen by setup state
(DESIGN.md I1–I10, spec `docs/onboarding-2611/feature-intros.md`).
Generally available (no feature flag). Until the organization is loaded,
every surface here renders nothing and pages show their own empty states.

## Files

| File | What |
|---|---|
| `types.ts` | `FeatureIntroKey` (all keys, with or without content yet), `FeatureIntro`, `FeatureIntroContext`, `defineFeatureIntro` |
| `intros/index.ts` | The registry. Add one file per section (`intros/ai-gateway.tsx`, `intros/auth-security.tsx`, `intros/connectors.tsx`, `intros/members.tsx`, `intros/team-detail.tsx`, `intros/plugins.tsx`, `intros/workbot.tsx`) and spread it into `FEATURE_INTROS` |
| `intros/examples/example-parts.tsx` | Shared pieces for live examples: caption, group label, rows, avatar, service logo (`ExampleServiceMark`, same lookup as `ConnectorLogo`) |
| `model.ts` | Pure rules: matching, dot rule, banner dismissal, size selection, CTA choice (tested in `model.test.ts`) |
| `feature-intro-data.ts` | `useFeatureIntroStates` (GET `/v1/me/feature-intros`) and `useFeatureIntroEvent` (POST `/events`, optimistic) |
| `feature-intro-provider.tsx` | `FeatureIntroProvider`, mounted in `dashboard/layout.tsx` |
| `feature-intro-gate.tsx` | `FeatureIntroGate`, `useFeatureIntro`, `useFeatureIntroUnseen`, `useFeatureIntroDot` |
| `feature-intro-views.tsx` | `FeatureIntroFullscreen`, `FeatureIntroBox`, `FeatureIntroBanner`, `FeatureIntroExample`, locked action, docs link |
| `feature-intro-help-button.tsx` | `?` in the top bar (dialog, `?` shortcut) and `FeatureIntroNavDot` for the sidebar |

## Add an intro

1. Make sure its key is in `FeatureIntroKey` (`types.ts`).
2. Write it in `intros/<section>.tsx` with `defineFeatureIntro<Facts>()`:

```tsx
type GatewayFacts = { providers?: number; smartRouters?: number; openworkModels?: boolean };

export const aiGatewayIntros = [
  defineFeatureIntro<GatewayFacts>({
    key: "ai-gateway",
    version: 1,
    match: { path: "/dashboard/ai-gateway" },
    icon: Network,
    title: "AI Gateway",
    summary: "Give your whole team models without sharing keys.",
    body: "…",                        // ≤ 3 sentences, full screen only
    highlights: [{ title: "OpenWork Models", text: "ready to use, no keys." }],
    example: { Component: AiGatewayExample, alt: "Providers flow through the gateway to each person's desktop." },
    docsUrl: "https://openworklabs.com/docs/ai-gateway",
    ctas: [
      { when: (ctx) => ctx.can("canManageModelsSettings"), label: "Add your first AI provider", href: "/dashboard/ai-gateway/providers/new" },
      { when: () => true, label: "Use these models in OpenWork", href: "/dashboard", locked: { reason: "Your admin manages models" } },
    ],
    setupState: ({ facts }) => (facts.providers ?? 0) > 0 || facts.openworkModels ? "done" : "none",
  }),
  defineFeatureIntro<GatewayFacts>({
    key: "ai-gateway.ai-providers",
    parent: "ai-gateway",
    match: { path: "/dashboard/ai-gateway", tab: "ai-providers" },
    bannerText: "Smart routers pick the best model for each task across your providers.",
    // …
    setupState: ({ facts }) => !facts.providers ? "none" : !facts.smartRouters ? "partial" : "done",
  }),
];
```

3. Register it: `export const FEATURE_INTROS = [...aiGatewayIntros];` in `intros/index.ts`.

Rules: one action straight to the form (I5), verb-first, sentence case, no
arrow; members get a `locked` variant, never an action they can't complete
(I6). The example is a small render of our own components on sample data
(`*-example-data.ts` next to it), no API calls; it is framed, labelled
"Example", hidden from pointer and screen readers (`alt` is read instead) and
static under reduced motion.

## Wire a page

Pages pass facts they already load. `null` means "still loading": the page
renders unchanged until the facts are known, so a set-up page never flashes an
intro.

```tsx
// Page level: replaces the whole page (tabs included) while the section has nothing set up.
<FeatureIntroGate introKey="ai-gateway" facts={loaded ? { providers, smartRouters, openworkModels } : null}>
  <UnderlineTabs tabs={tabs.map((t) => ({ ...t, unseen: introUnseen(`ai-gateway.${t.value}`) }))} … />

  {/* Tab level: box in place of the empty list, banner above a partly set-up tab. */}
  <FeatureIntroGate introKey="ai-gateway.limits" facts={policies ? { policies: policies.length } : null}>
    <LimitsList … />
  </FeatureIntroGate>
</FeatureIntroGate>
```

where `const introUnseen = useFeatureIntroUnseen();` (only pass keys that
exist in `FeatureIntroKey`).

Size (I2), decided by `selectIntroSize`:

- parent (section) `none` → the section's full screen, in place of the gate's children;
- this intro `none` → full screen for a section, box for a tab;
- `partial` → banner above children (hidden 30 days after dismiss);
- `done` → children only.

Facts reported by the gates mounted now are merged per section root
(`ai-gateway`), so a tab gate can tell its parent's state; pass section-level
facts on the page gate. A gate withdraws its facts when it unmounts or its
facts go back to `null` (loading), so facts from a page left earlier (e.g. the
gateway before its first provider) never decide what a tab shows later.

An intro's own setup (for dots) is read from facts only while its own gate is
mounted, never guessed from other tabs' facts; the last known state is cached
per organization *and member* in `localStorage` so sidebar dots stay quiet for
set-up sections on later visits.

Facts must describe the organization, not the viewer. When a list is filtered
to what this person may see (e.g. `/v1/plugins` or `/v1/marketplaces` without
`sharing.manage_all`), pass counts through `visibleCountFact(count,
seesWholeOrg)`: items there prove setup, an empty list stays unknown, so a
teammate's private work never makes someone else see "nothing set up".

Need custom placement? `useFeatureIntro(key, facts)` returns
`{ size, intro, element }` and renders nothing itself.

`?`-only intros: a page that is already its own next step (Home, OpenWork
Web, My bot, setup forms such as `library.connectors.add`) has an intro whose
`setupState` is always `"done"`. It never shows on its own; the page calls
`useFeatureIntro(key, {})` (or `null` where it loads none of the section's
facts, e.g. `LibrarySetupIntro`) so `?` can open it.

Settings forms and reports with nothing to set up (General, Diagnostics,
Billing, Desktop policies; `intros/settings.tsx`) set `helpOnly: true`: the
URL match answers `?`, no page wiring is needed, and they never get a sidebar
dot (their setup always counts as done).

## Tracking

- A mounted gate records `seen` once per mount (at most hourly per intro),
  whether or not an intro is visible, so visiting a set-up page clears its dot.
- CTA click records `cta_clicked`, then the `Link` navigates.
- Banner × records `dismissed`.
- `?` records `seen` when opened.
- Bump `version` to show an intro again to everyone; older rows count as unseen.

Dot rule (I9): `!setUp && (lastSeenAt == null || now - lastSeenAt > 30d)`.
When the page hasn't reported its setup yet, only a never-viewed intro gets a
dot. Dots are neutral: `UnseenDot` in `_components/ui/tabs.tsx`
(`TabItem.unseen`, sidebar via `FeatureIntroNavDot`).

## `?` button

Shows in the top bar when an intro covers the page: the
most specific of the URL match (path + tab, then path) and the gates mounted
on the page. Opens the full intro in a dialog even when set up.

## Tests

`model.test.ts` and per-section tests such as `intros/auth-security.test.ts` (node:test, run like other den-web tests):

```sh
cd ee/apps/den-api && TSX_TSCONFIG_PATH=../den-web/tsconfig.json pnpm exec node --conditions=development --import tsx --test '../den-web/app/(den)/dashboard/_features/feature-intros/model.test.ts' '../den-web/app/(den)/dashboard/_features/feature-intros/intros/auth-security.test.ts'
```
