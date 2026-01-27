# Skill Indicator Implementation

## Overview
This document describes the skill invocation indicator feature added to OpenWork's session view. When a skill is triggered during a session, it's now clearly marked in the UI using OpenWork's existing visual language.

## Implementation

### 1. Skill Detection Utilities (`src/app/utils.ts`)

Two new utility functions were added to detect and identify skill invocations:

#### `isSkillInvocation(part: Part): boolean`
Detects if a tool part represents a skill invocation by checking:
- Tool name prefix: `skill:*` pattern
- Metadata field: `part.state?.isSkill === true`
- Falls back gracefully for future SDK native events

#### `extractSkillName(part: Part): string | null`
Extracts the skill name from a skill part:
- Removes `skill:` prefix if present
- Uses `part.state?.skillName` if available
- Returns null if not a skill or name cannot be determined

### 2. Enhanced Step Summarization (`src/app/utils.ts`)

Updated `summarizeStep()` function:
- Added optional `isSkill` property to returned object
- Detects skill invocations early in tool part processing
- Preserves all existing functionality for non-skill tools
- Uses extracted skill name as the title when available

### 3. Session View Updates (`src/views/SessionView.tsx`)

**Imports:**
- Added `Sparkles` icon from `lucide-solid`
- Added skill detection utilities

**Step Rendering Enhancement:**
- Added skill badge indicator with amber/gold styling for visual prominence
- Badge displays "Skill" label with Sparkles icon
- Positioned inline with step title for clear association
- Only displays when `isSkillInvocation()` returns true
- Maintains flex layout for proper spacing

**Visual Design:**
- Badge: `bg-amber-500/20 border border-amber-500/30`
- Text: `text-amber-200`
- Icon: `Sparkles` (10px, included in badge)
- Consistent with OpenWork's existing badge patterns (compare to status badges)

### 4. Part View Component Updates (`src/components/PartView.tsx`)

**Imports:**
- Added `Sparkles` icon and skill detection utilities

**Tool Rendering Enhancement:**
- Added skill badge next to tool name in developer mode
- Tone-aware styling:
  - Dark tone (user messages): amber text with darker background
  - Light tone (assistant messages): amber text with lighter background
- Maintains consistent spacing with existing layout

## Design Philosophy

### SDK-First Approach
- Relies on OpenCode SDK structure and Part types
- Detects skills through common patterns (`skill:` prefix, metadata fields)
- Designed to work with SDK-native events when available (future-proof)

### Minimal Fallback
- Only falls back to pattern matching if no SDK signal exists
- Pattern matching is conservative and explicit
- Won't trigger on false positives

### Visual Language Consistency
- Uses existing OpenWork badge/badge patterns
- Color choice (amber/gold) signals "special" without being intrusive
- Icon (`Sparkles`) aligns with OpenWork's skill concept
- Maintains dark mode compatibility

## User Benefits

1. **Transparency**: Users immediately see when a skill is being used
2. **Confidence**: Clear indication builds trust in the system
3. **Learning**: Helps users understand what capabilities are available
4. **Debuggability**: Easier to track which skills are running

## Future Enhancements

1. **Click to View Skill Details**
   - Add tooltip/modal showing skill metadata from `.opencode/skill/*/SKILL.md`
   - Link to skill documentation

2. **Skill Performance Metrics**
   - Display execution time for completed skills
   - Show success/error rates

3. **Skill Permissions**
   - Visual indication of what the skill is accessing
   - Integration with OpenWork's permission system

4. **Skill Chaining**
   - Show dependencies between skills
   - Visual timeline of multi-skill workflows

## Testing Checklist

- [ ] Skill with `skill:` prefix is detected and badged
- [ ] Regular tools without skill metadata are not badged
- [ ] Badge renders correctly in collapsed step view
- [ ] Badge renders correctly in expanded step view
- [ ] Developer mode shows skill indicator in PartView
- [ ] Skill name is extracted and displayed accurately
- [ ] Visual styling matches design (amber/gold color)
- [ ] Works in both dark and light modes
- [ ] No performance degradation from checks
- [ ] Responsive on mobile screens

## Code Files Modified

1. `src/app/utils.ts` - Added skill detection and enhanced summarizeStep
2. `src/views/SessionView.tsx` - Added skill badge to step list
3. `src/components/PartView.tsx` - Added skill badge to developer tool view

## Related Documentation

- OpenWork Session: [src/views/SessionView.tsx](src/views/SessionView.tsx)
- Skill Management: [src/views/SkillsView.tsx](src/views/SkillsView.tsx)
- OpenCode Primitives: [.opencode/skill/opencode-primitives/SKILL.md](.opencode/skill/opencode-primitives/SKILL.md)
