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
- Prefer rounded geometry everywhere:
  - Large containers: `rounded-[2rem]` to `rounded-[2.5rem]`
  - Medium cards: `rounded-2xl`
  - Buttons/chips: `rounded-full`

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

### Interaction philosophy

- Default state should already look finished.
- Hover should sharpen or brighten, not radically restyle.
- Active state should feel selected through fill, weight, and shadow.
- Primary action is almost always a dark filled pill.
- Secondary action is usually a white/translucent pill with border.

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

### Landing cards

- Prefer larger rounded cards with blur and depth.
- Each card should have a single idea.
- Use a tint or micro-illustration to separate categories.
- Headings are medium weight, not overly bold.

### CTA rules

- Primary CTA: dark navy/black pill, medium weight.
- Secondary CTA: white or translucent with border.
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
