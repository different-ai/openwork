---
name: agent-first-screenshots
description: Agent-first screenshots — an agent drives the real app via CDP and produces clean, defect-free product screenshots (newsletters, landing pages, social, decks, PR). Dual-channel verification (DOM + pixels + vision) in a capture loop. Use for any "take/redo screenshots of the app" task.
---

# Agent-First Screenshots

An **agent-first screenshot** is a screenshot produced by an agent driving the real
app through automation, where the agent's "eyes" are the DOM and the pixels (not human
vision), and the frame is gated by **structural + visual verification** before it ships.
It turns screenshots from hand-crafted artifacts into a regenerable pipeline.

Use this skill for any "take screenshots of the app / redo these screenshots / make
marketing images" task. Use `daytona-flow-validator` or `daytona-recording-artifacts`
for pass/fail e2e evidence instead.

## The Zero-Defect Bar (the one that matters most)

**A demo screenshot must have ZERO obvious visual defects.** The bar is not "the
content is present" or "it's a valid state" — the bar is: *would a human glancing at
this immediately spot something broken?* If yes, it is disqualified. Full stop.

Obvious defects include (this is a class, not a list):
- Overlapping text or elements
- Clipped / cut-off text or controls
- Misaligned, broken, or collapsed layout
- Garbled, double-rendered, or mid-transition content
- Empty/blank regions where content should be
- Stray modals, tooltips, or panels covering content

A screenshot is shippable only when **a person would look at it and notice nothing
wrong.** Everything below exists to enforce that bar.

## The One Method

**Operate the app like a power user preparing a demo, not like a developer hacking the DOM.**

A great screenshot shows a real, working app doing real things — composed beautifully,
with distractions removed and **no visible defects**. The app already looks great. The
agent's job is to get it into a real, settled state and capture it cleanly, not to
rebuild it.

## Golden Rules

### 1. Only remove, never add

Hiding a specific notification badge or "Sign in" button via `display: none` is safe —
it's a leaf element that doesn't affect layout flow.

**Never** do these — they break the layout engine:

- Inject fake HTML components (voice panels, model lists, chart data)
- Override CSS flex properties (`flex-grow`, `flex-basis`, `height: 100%`)
- Add `margin`, `padding`, or `width` overrides to structural containers
- Add `position: fixed` overlays that cover real content
- Modify the DOM tree structure (insertBefore, appendChild on app containers)

The app's CSS is a carefully balanced flex system. Any structural modification risks
collapse — scroll areas shrink to 0, content disappears, and the screenshot is blank.

### 2. If a feature isn't available, don't fake it

If the voice extension isn't enabled, either:
- Enable it through the settings UI (like a real user would)
- Or skip that shot and tell the user it's not available

A fake panel will never match the real component's rendering. It will always look
wrong to someone who has seen the app.

### 3. Each shot starts from a clean reload

Don't carry DOM state across shots. After each capture:

1. Reload the page (`location.reload()`)
2. Wait for the app to fully render
3. Navigate to the desired screen
4. Do minimal cleanup (hide leaf distractions only)
5. Verify content is visible
6. Capture

This eliminates accumulated CSS hacks that cause layout collapse.

### 4. Verify with BOTH the DOM and the pixels, in a loop

`innerText` existing doesn't mean it's visible, and a healthy DOM rect doesn't
mean it actually rendered. Use two complementary channels:

**DOM pre-check (cheap, before capture):** the scroll area must have real height
(not collapsed to 32px); hero text must be inside the viewport rect; no
unexpected modal/overlay in the tree.

```js
var scrollArea = document.querySelector('.scrollable-selector');
var rect = scrollArea.getBoundingClientRect();
if (rect.height < 100) { /* ABORT — layout broken, reload and redo */ }
```

**Pixel post-check (truth, after capture):** decode the PNG and sample the
DOM-derived hero rects (scaled by deviceScaleFactor). This catches blank renders
the DOM can't see.

**Calibration insight (critical):** for text-on-white UI, **background ratio is
a bad signal** — a full conversation is naturally 85-92% background pixels (text
is sparse). **Variance is the reliable signal:** a content-filled region has
luminance variance > ~200 (often 1000+); a blank/flat region is < 50. Use:
- whole-image `bgRatio > 0.97` → blank frame
- per-region `variance < 200` → that region didn't render (the real catch)
- per-region `bgRatio > 0.96` → only as a secondary blank check

Reusable scripts live in this skill's directory:
`screenshot-verify.mjs` (verify an existing PNG) and `capture-verify.mjs`
(capture at 2x + verify regions + save only on pass). Both use `sharp` for
raw-pixel access. The loop: operate -> DOM pre-check -> capture -> pixel verify
-> if fail, diagnose and fix -> recapture, until both channels pass.

**Layer 3 (vision) — MANDATORY, not optional.** Deterministic stats CANNOT catch
the defect class that matters most: overlapping text, clipping, misalignment,
double-rendering. Overlapping text still has high variance and normal background
ratio — Layers 1-2 pass it happily. **Only a vision pass catches it.** So every
frame that passes Layers 1-2 must then pass a vision check before shipping.

Hand the PNG to a vision-capable model (vision subagent, or an API call whose
JSON the orchestrator reads) with a zero-defect rubric:

```
"You are QA for a product screenshot. A real person must notice NOTHING wrong.
Return JSON:
{
  any_obvious_defect: bool,        // the gate — if true, REJECT
  overlapping_text_or_elements: bool,
  clipped_or_cutoff: bool,
  misaligned_or_broken_layout: bool,
  blank_or_empty_regions: bool,
  stray_modal_tooltip_or_panel: bool,
  legible: bool,
  polish_score: 1-5,
  defects: ['title overlaps Save button', ...]
}"
```

If `any_obvious_defect` is true, the frame is rejected no matter what Layers 1-2
said. Map each defect to a fix (see table below) and recapture.

### 5. Get the app into the right state naturally

- Navigate through the UI (click tabs, open panels, run tasks)
- Run real tasks that produce impressive output (not toy data)
- Open split view by clicking the actual "Open in split view" button
- Open the model picker by clicking the actual model selector
- Close panels by clicking the actual close button

If a panel is open that shouldn't be, close it through the UI — don't hide it
with CSS.

### 6. Hide only leaf distractions

Safe to hide (leaf elements that don't affect layout):

- Notification badges (`[aria-label*="Notification"]`)
- Footer links ("Sign in", "Docs", "Feedback")
- Status text ("Ready for new tasks")
- Right rail icon buttons (Browser, Extensions, Settings)

Never hide:

- Flex container children (causes layout collapse)
- Scroll areas
- Main content wrappers
- Panel containers (close via UI instead)

### 7. Use real, impressive content

- Run multi-turn tasks so conversations have depth
- Use realistic data (org names, revenue numbers, code that looks like real work)
- Wait for streaming, animations, and loading to fully settle
- No "alice.johnson@example.com" toy data

### 8. Match the target aspect ratio

Set the viewport to match the newsletter/landing page target:

- 1440x900 at 2x DPR = 2880x1800 (good for most web use)
- 1920x1080 at 2x DPR = 3840x2160 (4K, for full-bleed hero shots)

Apply via CDP:
```js
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false
});
```

After applying metrics override, wait 1s and re-verify content visibility —
the override can trigger re-layout.

## Workflow

### 1. Plan the shot list

Decide what story each frame tells. Tie every shot to a value prop. If a frame
doesn't answer "why would I want this?", drop it.

### 2. For each shot (the loop):

1. **Reload** the page to get a clean state
2. **Navigate** to the desired screen through the UI
3. **Wait** for content to fully render (3s for SPA navigation) and **settle**
   (no mid-transition, no edit-mode unless intended)
4. **Hide leaf distractions** only (badges, footer links, status text)
5. **Apply 2x metrics** via CDP, **wait 1s** for re-layout
6. **DOM pre-check**: scroll area height > 100px, hero text in viewport, no stray modal
7. **If DOM check fails**: reload and redo — never fix with more CSS
8. **Capture** via `Page.captureScreenshot`
9. **Pixel verify (Layers 1-2)**: file size 200KB+, region variance > 200
10. **Vision verify (Layer 3, mandatory)**: `any_obvious_defect` must be false —
    catches overlap/clipping/misalignment that Layers 1-2 cannot
11. **If any layer fails**: diagnose, fix the root cause, recapture. Ship only when
    all three pass and a person would notice nothing wrong.

### 3. Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Overlapping text (e.g. title over Save button) | Captured an unsettled / edit-mode / wrong-width state; only vision catches it | Open in preview (not edit) mode, let layout settle, gate on the vision check |
| Screenshot is blank/empty | Flex container collapsed | Reload page, don't hide structural elements |
| Scroll area is 32px tall | Sibling panel was hidden with `display:none` | Close panel via UI, don't CSS-hide it |
| Model picker overlay on all shots | Picker was opened and never closed | Close picker (Escape) before capturing other shots |
| Content in DOM but not in pixels | Element clipped/hidden/blank render | Pixel variance check + vision check, not `innerText` |
| Voice panel overlaps chat | Fixed-position overlay covers content | Don't inject overlays — enable feature through UI |
| File size under 150KB | Mostly blank image | Re-verify content visibility before capture |

## Technical Reference

### Capture via direct CDP (retina)

```js
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false
});
await wait(1000); // let layout settle

// VERIFY before capture
const check = await evalJs(`(() => {
  var sa = document.querySelector('.scrollable-selector');
  if (!sa) return { ok: false };
  var rect = sa.getBoundingClientRect();
  return { ok: rect.height > 100, height: rect.height };
})()`);
if (!check.ok) { /* ABORT, reload and redo */ }

const shot = await send("Page.captureScreenshot", {
  format: "png", fromSurface: true, captureBeyondViewport: false
});
fs.writeFileSync(path, Buffer.from(shot.data, "base64"));
await send("Emulation.clearDeviceMetricsOverride");
```

### Hide leaf distractions (safe)

```js
// Only hide specific buttons/badges, never structural containers
document.querySelectorAll('[aria-label*="Notification"]').forEach(el => el.style.display = 'none');
document.querySelectorAll('button').forEach(b => {
  if (['Sign in', 'Docs', 'Feedback'].includes(b.innerText.trim())) b.style.display = 'none';
});
```

## Anti-patterns

- **Injecting fake components.** A fake voice panel or fake chart data will never
  match the real app's rendering. Enable the feature through the UI or skip the shot.
- **Overriding flex properties.** Changing `flex-grow`, `height`, or `flex-basis`
  on containers breaks the layout engine. Reload instead.
- **Fixed-position overlays.** A `position:fixed` div covering the right side
  hides the real content behind it. Never use overlays.
- **Carrying state across shots.** CSS hacks accumulate and eventually break
  layout. Reload between shots.
- **Verifying via innerText only.** Text in the DOM doesn't mean it's visible.
  Always check `getBoundingClientRect`.
- **Proof-frame mindset.** This is not e2e evidence. The goal is "I want that,"
  not "it didn't crash."
