# Radix Color Scale Reference

Source: https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale

## Scale Steps (1-12)
- 1: App background
- 2: Subtle background
- 3: UI element background (normal)
- 4: UI element background (hover)
- 5: UI element background (active/selected)
- 6: Subtle borders and separators
- 7: UI element border and focus rings (interactive)
- 8: Hovered UI element border / stronger focus rings
- 9: Solid backgrounds (highest chroma)
- 10: Hovered solid backgrounds
- 11: Low-contrast text
- 12: High-contrast text

## Background Guidance (Steps 1-2)
- Use steps 1-2 for main app backgrounds and subtle component backgrounds.
- Typical surfaces: app background, sidebar, cards, canvas area, striped tables, code blocks.
- Light mode may use white; dark mode can use step 1-2 from a neutral scale.

## Component Backgrounds (Steps 3-5)
- Step 3: default component background.
- Step 4: hover state background.
- Step 5: pressed or selected background.
- If the default background is transparent, use step 3 for hover.

## Borders (Steps 6-8)
- Step 6: subtle borders for non-interactive containers (cards, panels, separators).
- Step 7: subtle borders for interactive components.
- Step 8: stronger borders for interactive components and focus rings.

## Solid Backgrounds (Steps 9-10)
- Step 9: purest color in scale; use for solid accents, brand surfaces, overlays.
- Step 10: hover state for step 9 backgrounds.
- Most step 9 colors expect white text; exceptions: Sky, Mint, Lime, Yellow, Amber expect dark text.

## Text (Steps 11-12)
- Step 11: low-contrast text.
- Step 12: high-contrast text.

## Contrast Notes
- Steps 11 and 12 are designed to meet APCA targets over step 2 backgrounds from the same scale.
