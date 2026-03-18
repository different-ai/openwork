# OpenWork Style Guide

## Principles
1. **Premium & Native Feel**: The experience must feel polished, native to the OS, and not utilitarian. 
2. **Subtle & Restrained**: Use restrained typography, subtle shadows, and neutral grays with deliberate, constrained accent colors.
3. **Typography**: "Avenir Next", "Segoe UI Variable", "Segoe UI", "Inter", sans-serif. Focus on tight tracking (`tracking-tight`) for headers, readable (`leading-relaxed`) for body.
4. **Shapes**: Pill shapes and heavily rounded corners for floating UI elements (`rounded-xl`, `rounded-2xl`).

## Core Variables (Tailwind / CSS)

### Colors
- **Backgrounds**: 
  - Canvas: `bg-neutral-100` (soft, gray-tinted canvas)
  - Modals/Surfaces: `bg-white`
  - Secondary/Hover: `bg-neutral-50`, `hover:bg-neutral-100/80`
- **Text**:
  - Primary: `text-neutral-900`
  - Secondary/Muted: `text-neutral-500`, `text-neutral-400`
- **Accents**:
  - Primary buttons: `bg-neutral-900 text-white hover:bg-neutral-800`
  - Primary links/accents: `text-emerald-600`
  - Warning/Alert: `bg-amber-50/50 text-amber-800 border-amber-100`

### Shadows & Borders
- **Shadows**: 
  - Modal: `shadow-[0_20px_50px_-12px_rgba(0,0,0,0.15)]`
  - Cards: `shadow-sm hover:shadow-md`
- **Borders**: 
  - Primary borders: `border-neutral-200`
  - Hover states: `hover:border-neutral-300`

### Interactive States
- **Hover**: Subtle background shifts (`hover:bg-neutral-100/50`), border color changes.
- **Active/Focus**: Use `outline-none focus:ring-2 focus:ring-neutral-900/5`, or subtle scale downs (`active:scale-[0.98]`).

## Shared Components & Layouts

### Modals
Modals should feel like lightweight, floating cards with strong shadows and clean separation of header, body, and footer areas.
- Width constraint: `max-w-lg`
- Border radius: `rounded-2xl`
- Animation: `animate-in fade-in zoom-in-95 duration-300`

### Cards/Rows
List items or sections inside a view should be wrapped in bordered, rounded containers.
- Border radius: `rounded-2xl`
- Padding: `p-4` or `p-3`
- Border: `border border-neutral-200`

### Inputs
Inputs should feel substantial but soft.
- Padding: `py-3 pl-4`
- Border radius: `rounded-xl`
- Background: `bg-neutral-50`
- Font: Use `font-mono` for tokens, URLs, IDs. `text-[13px]`.
