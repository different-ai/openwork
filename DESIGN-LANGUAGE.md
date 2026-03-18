# OpenWork Design Language

This is the default visual language for OpenWork product and marketing work unless a task explicitly asks for a different direction.

The goal is not generic SaaS polish. OpenWork should feel like calm, premium operational software: clear, light, slightly futuristic, and trustworthy enough for real work.

## Shared DNA

### Brand mood

- Calm, technical, premium, useful.
- More "precision tool with atmosphere" than "consumer toy".
- Friendly, but never cute.
- Futuristic through restraint, not chrome overload.

### Core palette

- Base background: `#f6f9fc`
- Primary ink: `#011627`
- Elevated white: `rgba(255,255,255,0.72)` to `rgba(255,255,255,0.95)`
- Soft border: `rgba(255,255,255,0.6)` or low-contrast slate border
- Muted text: slate/gray in the `500-600` range
- Accent gradients: warm orange, gold, cool blue, and restrained violet
- Accent gradients belong inside contained moments: illustrations, spotlight panels, active demo canvases
- Accent gradients do not replace the core shell background

### Material treatment

- Default shell is airy and bright.
- Large surfaces should feel like frosted panels on top of a luminous field.
- Use blur, translucent white fills, and soft shadows.
- Treat grain as a presentational layer, not content.
- Treat paper as the readable layer that sits above the atmospheric field.
- Prefer rounded geometry everywhere:
  - Large containers: `rounded-[2rem]` to `rounded-[2.5rem]`
  - Medium cards: `rounded-2xl`
  - Buttons/chips: `rounded-full`

### Grain and paper

- Grain belongs behind UI or inside isolated showcase canvases. It should never compete with text contrast or become the primary surface.
- Use grain to give the page atmosphere, depth, and a sense of motion; do not use it as a texture wash across every card.
- The canonical fixed-page grain treatment lives in `packages/landing/components/landing-background.tsx` and is powered by `packages/landing/components/responsive-grain.tsx`.
- Grain intensity should stay low on default page backgrounds; stronger color can appear only inside showcase moments like the enterprise canvas.
- Paper means the readable surface layer: white or warm off-white cards with enough opacity to feel stable over the grain field.
- The canonical paper shells live in `packages/landing/app/globals.css` via `.landing-shell`, `.landing-shell-soft`, and `.landing-chip`.
- Use `landing-shell` for primary frosted containers, `landing-shell-soft` for denser interior cards, and `landing-chip` for pills, filters, and lightweight app chrome.

### Shadows and borders

- Shadows should be soft, wide, and low-contrast.
- Borders should separate layers without looking outlined.
- Preferred pattern:
  - white/translucent card
  - white or slate-tinted border
  - soft shadow underneath

### Typography

- Primary UI type: a clean sans like Inter.
- Monospace: use only for commands, file paths, versions, and system tokens.
- Accent display type: `FK Raster Roman Compact Smooth` or similar raster/pixel serif accent.
- Use the pixel accent sparingly:
  - one emphasized word in a hero
  - one occasional label or wordmark treatment
  - never long paragraphs
- Default hierarchy:
  - Eyebrows: uppercase, tracked, small, muted
  - Headlines: medium weight, tight tracking, large scale
  - Body: relaxed line-height, soft gray, high legibility

### Motion

- Motion should support orientation, not decorate for its own sake.
- Preferred motion:
  - opacity fades
  - subtle translateY reveals
  - soft spring for active pills/tabs
  - hover lift of 1-2px max
- Background motion should be slow and atmospheric.
- Avoid bouncy UI, large parallax, or busy looping animation.
- Default landing interaction timing should use `300ms` with `cubic-bezier(0.31, 0.325, 0, 0.92)`.
- On interactive controls, prefer color/background/shadow transitions first, then a very small positional shift.

### Interaction philosophy

- Default state should already look finished.
- Hover should sharpen or brighten, not radically restyle.
- Active state should feel selected through fill, weight, and shadow.
- Primary action is almost always a dark filled pill.
- Secondary action is usually a white/translucent pill with border.

### Micro-interaction rules

- OpenWork should feel alive in small ways, especially on hover, focus, and active transitions.
- Micro-interactions should be visible enough to reward intent, but subtle enough to avoid feeling animated for its own sake.
- The most important place to get this right is buttons, tabs, cards, and interactive rows.

#### Button motion baseline

- Use `transition-duration: 0.3s`.
- Use `transition-timing-function: cubic-bezier(0.31, 0.325, 0, 0.92)`.
- Prefer transitions on:
  - `color`
  - `background-color`
  - `border-color`
  - `box-shadow`
  - `transform`

#### Primary button behavior

- Base state:
  - dark fill
  - white text
  - pill radius
  - compact horizontal padding
- Hover state:
  - shift upward slightly (`translateY(-1px)` or `-2px` max)
  - lighten or soften the dark fill rather than making it more saturated
  - keep the shadow tight and controlled
- Avoid oversized lift, glow, or springy bounce.

Reference hover target:

```css
.primary-button:hover {
  background-color: rgb(110, 110, 110);
  transform: translateY(-1px);
}
```

#### Secondary button behavior

- Base state:
  - white surface
  - dark text
  - pill radius
  - subtle border or edge definition
- Hover state:
  - background shifts to a soft center-gray (`rgb(242, 242, 242)`)
  - text remains dark
  - use a crisp micro-shadow so it feels tactile
  - no dramatic lift required; the color change is the main signal

Reference hover target:

```css
.secondary-button:hover {
  background-color: rgb(242, 242, 242);
  box-shadow:
    rgba(0, 0, 0, 0.06) 0px 0px 0px 1px,
    rgba(0, 0, 0, 0.04) 0px 1px 2px 0px,
    rgba(0, 0, 0, 0.04) 0px 2px 4px 0px;
}
```

#### Card and row behavior

- Cards may lift by `1-2px` max.
- Interactive rows should slightly darken or tint their background on hover.
- Active pills/tabs should animate with a soft spring or equivalent eased slide.
- Never rely on opacity-only hover for core controls when a clearer material shift would help.

## Core Tokens

Use this as the default starting point when building new UI in this language.

```css
:root {
  --ow-bg: #f6f9fc;
  --ow-ink: #011627;
  --ow-muted: #5f6b7a;
  --ow-card: rgba(255, 255, 255, 0.78);
  --ow-card-strong: rgba(255, 255, 255, 0.92);
  --ow-border: rgba(255, 255, 255, 0.72);
  --ow-border-soft: rgba(148, 163, 184, 0.20);
  --ow-shadow: 0 20px 60px -24px rgba(15, 23, 42, 0.18);
  --ow-shadow-strong: 0 24px 60px -24px rgba(15, 23, 42, 0.22);
  --ow-primary: #011627;
  --ow-primary-hover: #000000;
}
```

## OpenWork App

The app is not a marketing page. It should feel more operational, more focused, and more durable.

### App intent

- The app is where work happens.
- Readability, state clarity, and keyboard/mouse efficiency matter more than visual theater.
- Keep the atmosphere, but reduce spectacle.

### App shell blueprint

- Use a three-pane session shell by default:
  - Left rail: navigation and context
  - Center canvas: conversation + execution
  - Right rail: tools, inbox, artifacts, details
- Approximate widths:
  - Left rail: `~260px`
  - Right rail: `~280px`
  - Center canvas: fluid
- Reading width in the center should stay constrained enough for long-form scanning.
- Canonical landing-derived shell reference: `packages/landing/components/landing-app-demo-panel.tsx`.

### App background and surfaces

- Shell background: pale neutral/slate-tinted field, not pure white.
- Center canvas: strong white surface.
- Rails: slightly tinted from the center to maintain separation.
- Internal cards should use low-contrast borders before they use heavy shadows.

### App typography

- Chrome and controls: compact sans, medium weight.
- Assistant long-form text: may use a more editorial/serif treatment when it improves reading.
- System labels: small uppercase microcopy with tracking.
- Timestamps and metadata: quieter than the main row title.

### Left rail rules

- Organize by worker/workspace group, not decorative categories.
- Rows should feel compact but touch-safe.
- Active session state should be obvious through fill/tint, not only text weight.
- Hover actions should appear progressively, not all at once.
- Use worker pills and compact metadata rows like the left column in `packages/landing/components/landing-app-demo-panel.tsx`.

### Center canvas rules

- Chat timeline is the visual anchor.
- User messages are compact rounded bubbles.
- Assistant output should breathe more and use generous line-height.
- Tool execution blocks should be grouped and legible before they are pretty.
- Composer should feel docked and important, not lost in the page.

### Composer rules

- Floating dock with subtle fade into the page bottom.
- Workspace mode label above or inside composer.
- Agent/model/tool selectors appear as chips or compact menus.
- Send button should be a strong circular or pill blue affordance.
- The default visual reference for task + context + result composition is the composer block in `packages/landing/components/landing-app-demo-panel.tsx`.

### Right rail rules

- Treat it as a utility rail, not a second content canvas.
- Capabilities should look tab-like and quickly scannable.
- Files and artifacts should prioritize file name, type, and action clarity.
- Document detail panels should open in-context rather than ejecting users elsewhere.

### App motion rules

- Favor transitions in `opacity`, `color`, `background`, `shadow`.
- Use pulse/spinner only to communicate active work.
- Avoid decorative motion that competes with chat comprehension.

### App implementation checklist

- Is the layout instantly scannable at a glance?
- Can the active session, active tool area, and composer be identified in under 2 seconds?
- Are hover states helpful without making the idle UI noisy?
- Are rails visually related but clearly separated?
- Is long-form assistant output comfortable to read for several paragraphs?

## OpenWork Landing

The landing experience should feel like the same company as the app, but more cinematic, more spacious, and more persuasive.

### Landing intent

- The landing page sells trust through clarity, polish, and product specificity.
- It should feel designed, not template-generated.
- Every section should prove something: credibility, capability, safety, or readiness.

### Landing shell

- Overall background starts with the same pale cloud field as the app.
- Add slow atmospheric grain gradients as a fixed background layer.
- Use a centered content column around `max-w-5xl`.
- Page rhythm should alternate between:
  - open text-led sections
  - frosted demonstration panels
  - dense proof/feature blocks
- Canonical shell references:
  - `packages/landing/components/landing-background.tsx`
  - `packages/landing/components/responsive-grain.tsx`
  - `packages/landing/app/globals.css`

### Landing navigation

- Minimal top bar.
- Left: mark + wordmark.
- Middle: a small number of essential links only.
- Right: one clear download CTA and GitHub/social proof.
- Mobile nav should keep the same materials: glass, rounded, calm.

### Landing hero

- One strong headline.
- One raster/pixel accent word at most.
- One short paragraph.
- Two CTAs max:
  - primary dark pill
  - secondary white/translucent pill
- Credibility line may sit beside or beneath CTAs.

### Landing showcase panels

- The primary demo area should feel like a product artifact, not a marketing illustration.
- Good patterns:
  - desktop window framing
  - real-ish task list or chat states
  - clear active selection states
  - visible task/result flow
- Use glass shells, white internals, and restrained gradients.
- Extract showcase UI into reusable components before duplicating it in new pages.
- Canonical app-interior reference: `packages/landing/components/landing-app-demo-panel.tsx`.
- Canonical share/package card reference: `packages/landing/components/landing-share-package-card.tsx`.
- Canonical cloud worker integration card reference: `packages/landing/components/landing-cloud-workers-card.tsx`.
- Source data for the rotating demo states lives in `packages/landing/components/landing-demo-flows.ts`.

### Landing cards

- Prefer larger rounded cards with blur and depth.
- Each card should have a single idea.
- Use a tint or micro-illustration to separate categories.
- Headings are medium weight, not overly bold.
- Reuse the share/package card pattern in `packages/landing/components/landing-share-package-card.tsx` when you need a paper card that explains packaging, bundling, or share-link creation.
- Reuse the worker/integration card pattern in `packages/landing/components/landing-cloud-workers-card.tsx` when you need to show remote readiness, worker state pills, or connector actions like Slack.

### CTA rules

- Primary CTA: dark navy/black pill, medium weight.
- Secondary CTA: white or translucent with border.
- Primary and secondary CTAs must have explicit hover states; do not leave them visually static.
- CTA copy should be short and direct:
  - `Download for free`
  - `Contact sales`
  - `Get started`
  - `Learn more`

### Landing section archetypes

Use these as the default recipes.

#### 1. Hero section

- Headline + supporting paragraph + CTA row + credibility marker.

#### 2. Product demonstration section

- Large glass window showing believable product behavior.
- Left rail + center conversation is the preferred composition.

#### 3. Split proposition section

- Two columns introducing desktop vs hosted/cloud or self-serve vs enterprise.

#### 4. Feature storytelling section

- Left side: textual choices/use cases.
- Right side: one vivid interactive or illustrative panel.

#### 5. Hosted/Den section

- Emphasize safe hosted workers, chat surfaces, and portability from existing setup.

#### 6. Enterprise section

- Use a calmer but still premium sales layout.
- Left side should explain what enterprise deployment means.
- Right side should contain the booking or contact action.
- Include proof of safety, permissions, and rollout clarity.

### Enterprise page recipe

When building a landing enterprise page in this language, use this structure:

1. Hero with eyebrow, strong headline, short proof paragraph.
2. CTA row with:
   - book/contact action
   - secondary route to Den or docs
3. Trust or platform strip:
   - built on OpenCode
   - works local or hosted
   - clear permissions and auditability
4. Left column of glass cards covering:
   - deployment modes
   - security/permission model
   - rollout support
5. Right column booking form in the strongest card on the page.
6. Footer matching the global landing shell.

### Landing implementation checklist

- Does the page feel like OpenWork before reading any copy?
- Is there exactly one dominant CTA in each section?
- Are gradients contained to moments of emphasis rather than spread everywhere?
- Is the raster accent used sparingly and intentionally?
- Are large cards rounded, translucent, and softly shadowed?
- Can a user understand the value proposition from the hero + first proof section alone?
- Are grain and paper clearly separated so readable content never sits directly on top of a noisy effect?
- If a section references the app, does it borrow from the extracted canonical components instead of inventing a second shell language?

## Do / Don't

### Do

- Use bright atmospheric backgrounds with layered grain or gradient fields.
- Use dark navy ink instead of generic black where possible.
- Use rounded, frosted white surfaces.
- Use motion to guide focus.
- Let the product itself be the visual centerpiece.

### Don't

- Don't default to flat white sections with generic SaaS icons.
- Don't overuse violet or neon accents.
- Don't make every card identical in hierarchy.
- Don't use the raster accent font in paragraphs or long labels.
- Don't make the app as visually loud as the landing page.

## Build Order

When creating a new OpenWork UI from scratch, implement in this order:

1. Establish background field and shell width.
2. Set typography system and only then choose the raster accent moment.
3. Build primary navigation and CTA hierarchy.
4. Build the main product/demo surface.
5. Add supporting glass cards.
6. Add restrained motion and hover transitions last.

## Companion References

- Product guidance: `AGENTS.md`
- App session-surface reference: `packages/docs/orbita-layout-style.mdx`
- Product landing implementation target: `packages/landing`
- Landing background + grain reference: `packages/landing/components/landing-background.tsx`
- Landing shell tokens + button behavior: `packages/landing/app/globals.css`
- Canonical app demo interior: `packages/landing/components/landing-app-demo-panel.tsx`
- Canonical share card: `packages/landing/components/landing-share-package-card.tsx`
- Canonical cloud worker card: `packages/landing/components/landing-cloud-workers-card.tsx`
