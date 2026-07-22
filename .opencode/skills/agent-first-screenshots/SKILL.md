---
name: agent-first-screenshots
description: Agent-first screenshots — an agent drives the real app via CDP and produces clean, defect-free product screenshots (newsletters, landing pages, social, decks, PR). Dual-channel verification (DOM + pixels + vision) in a capture loop. Use for any "take/redo screenshots of the app" task.
---

# Agent-First Screenshots

An **agent-first screenshot** is produced by an agent driving the real app via
CDP, gated by **structural + pixel + vision verification** before it ships. It
turns screenshots from hand-crafted artifacts into a regenerable pipeline.

Use this for "take/redo screenshots / make marketing images" tasks. It is NOT
e2e evidence — for pass/fail proof use the `fraimz` skill.

## The Zero-Defect Bar

**A shippable screenshot has ZERO obvious visual defects** — the bar is not
"the content is present", it is: *would a human glancing at it immediately spot
something broken?* Overlapping or clipped text, misaligned/collapsed layout,
garbled or mid-transition content, blank regions, stray modals/tooltips — any
of these disqualifies the frame. Full stop.

## The One Method

**Operate the app like a power user preparing a demo, not like a developer
hacking the DOM.** The app already looks great: get it into a real, settled
state through the UI and capture it cleanly. Never rebuild or fake it.

## Golden Rules

1. **Only remove, never add.** Hiding a leaf distraction (notification badge,
   "Sign in" footer link, status text) via `display:none` is safe. Never
   inject fake HTML, override flex/height/width on structural containers, add
   fixed-position overlays, or mutate the DOM tree — the layout engine will
   collapse (scroll areas shrink to 0, content disappears).
2. **If a feature isn't available, don't fake it.** Enable it through the
   settings UI like a real user, or skip the shot and say so.
3. **Each shot starts from a clean reload.** `location.reload()`, wait for
   full render, navigate through the UI, minimal leaf cleanup, verify, capture.
   Never carry CSS hacks across shots.
4. **Get state naturally.** Click the real tabs/buttons/pickers; close panels
   via their close buttons (not CSS); run real multi-turn tasks so content is
   impressive — no toy data, no mid-stream captures.
5. **Match the target aspect ratio** via CDP metrics override (e.g. 1440x900
   at `deviceScaleFactor: 2`), then wait ~1s and re-verify — the override can
   trigger re-layout.

## Verify with three channels, in a loop

`innerText` existing does not mean visible; a healthy DOM rect does not mean it
rendered. Every frame must pass all three before it ships:

1. **DOM pre-check (cheap, before capture):** scroll area height > 100px (not
   collapsed), hero text inside the viewport rect, no unexpected modal/overlay.
   If it fails: reload and redo — never fix with more CSS.
2. **Pixel post-check (truth, after capture):** decode the PNG and sample the
   DOM-derived hero rects. Calibration: for text-on-white UI, background ratio
   is a bad signal (85–92% background is normal). **Variance is the reliable
   signal**: content-filled region variance > ~200 (often 1000+); blank/flat
   region < 50. Whole-image `bgRatio > 0.97` → blank frame.
3. **Vision check (mandatory gate):** deterministic stats CANNOT catch the
   defects that matter most — overlap, clipping, misalignment,
   double-rendering. Hand the PNG to a vision-capable model with a zero-defect
   rubric returning JSON:

   ```
   { any_obvious_defect: bool,   // the gate — if true, REJECT
     overlapping_text_or_elements: bool, clipped_or_cutoff: bool,
     misaligned_or_broken_layout: bool, blank_or_empty_regions: bool,
     stray_modal_tooltip_or_panel: bool, legible: bool,
     polish_score: 1-5, defects: ["..."] }
   ```

   If `any_obvious_defect` is true the frame is rejected regardless of layers
   1–2. Diagnose, fix the root cause (settle the state, close the picker,
   reload), recapture.

Reusable scripts in this skill's directory: `screenshot-verify.mjs` (verify an
existing PNG) and `capture-verify.mjs` (capture at 2x + verify regions + save
only on pass); both use `sharp`.

## Beautify (Screen.Studio-style framing)

`scripts/beautify.mjs` turns a verified raw screenshot into a publication
frame: gradient background, padding, rounded corners, soft shadow, optional
window chrome. Zero extra deps (resolves `sharp` from the pnpm store — run
from a repo root that has `node_modules`).

```bash
node scripts/beautify.mjs in.png out.png [flags]
#  --bg paper|indigo|slate|peach|ocean|violet|"#hex,#hex[,#hex]"  --bg-angle 135
#  --pad 7            padding as % of long side
#  --radius 24        corner radius (output px; raws are usually 2x)
#  --chrome none|mac|browser   --title "OpenWork"   --url app.openworklabs.com
#  --width 1600       final width   --ratio 16:9    extend canvas, never crop
```

House style for packages/docs tutorials: cloud/dashboard shots use
`--chrome browser --url app.openworklabs.com --bg paper --width 1600`;
desktop shots use `--chrome mac --title OpenWork --bg indigo --width 1600`.
Beautify AFTER verification — framing is presentation, not proof.

## Common failure modes

| Symptom | Fix |
|---------|-----|
| Overlapping/clipped text (layers 1–2 pass) | Unsettled/edit-mode/wrong-width state — settle, use preview mode, gate on vision |
| Blank screenshot / 32px scroll area | Structural element was CSS-hidden — reload, close panels via UI |
| Overlay (picker/modal) on every shot | It was opened and never closed — Escape before capturing |
| In DOM but not in pixels | Clipped/blank render — trust variance + vision, not `innerText` |

## Anti-patterns

Injecting fake components; overriding flex properties; fixed-position
overlays; carrying state across shots; verifying via `innerText` only;
proof-frame mindset (the goal is "I want that", not "it didn't crash").
