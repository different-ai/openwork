# Context Panel: Collapse + Better Subtitles

**Branch:** `feat/context-panel-ux`
**Priority:** P0 (collapse) / P1 (subtitles)

---

## Problems

1. Too many sections expanded at once - overwhelming
2. File names show just basename, not enough to differentiate duplicates
3. Skill subtitles show vague descriptions, not trigger phrases
4. Files not clickable

### Code findings
- Context panel render: `packages/app/src/app/components/session/context-panel.tsx:116-285`
- Working files list is derived in utils: `packages/app/src/app/utils/index.ts:591` (currently uses `item.name` only)
- Artifacts include full paths: `packages/app/src/app/utils/index.ts:518`
- `SkillCard` type (name/path/description): `packages/app/src/app/types.ts:150`
- Frontmatter parsing on server: `packages/server/src/frontmatter.ts:1` and `packages/server/src/skills.ts:33`
- Existing open/reveal pattern: `packages/app/src/app/pages/mcp.tsx:154`

---

## Changes

### 1. Default collapsed sections

**File:** `packages/app/src/app/app.tsx` L1912-1920

```tsx
// BEFORE
const [expandedSidebarSections, setExpandedSidebarSections] = createSignal({
  progress: true,
  artifacts: true,
  context: true,
  plugins: true,
  mcp: true,
  skills: true,
  authorizedFolders: true,
});

// AFTER
const [expandedSidebarSections, setExpandedSidebarSections] = createSignal({
  progress: true,           // Keep: shows active task progress
  artifacts: true,          // Keep: shows outputs
  context: false,           // Collapse: working files can be overwhelming
  plugins: false,           // Collapse: not actionable for new users
  mcp: false,               // Collapse: technical detail
  skills: true,             // Keep: this is the key value prop
  authorizedFolders: false, // Collapse: technical detail
});
```

---

### 2. Smarter file path display

**File:** `packages/app/src/app/utils/index.ts` + `packages/app/src/app/components/session/context-panel.tsx`

**Problem:** Two files with same basename show identically:
```
/foo/bar/skill.md  →  skill.md
/baz/qux/skill.md  →  skill.md
```

**Solution:** Prefer workspace-relative path (or minimal unique path) using `item.path` from `deriveArtifacts` rather than `item.name`.

Update `deriveWorkingFiles`:
```tsx
// packages/app/src/app/utils/index.ts:591
const deriveWorkingFiles = (artifacts: ArtifactItem[]) =>
  artifacts
    .filter((item) => item.category === "file" && item.path)
    .map((item) => item.path ?? item.name);
```

Then apply minimal-unique display in the panel:
```tsx
const getSmartFileName = (files: string[], file: string): string => {
  const basename = file.split(/[/\\]/).pop() ?? file;
  
  // Check if basename is unique
  const duplicates = files.filter(f => 
    (f.split(/[/\\]/).pop() ?? f) === basename
  );
  
  if (duplicates.length === 1) {
    return basename;
  }
  
  // Find minimum path segments needed to differentiate
  const segments = file.split(/[/\\]/);
  for (let i = 2; i <= segments.length; i++) {
    const shortPath = segments.slice(-i).join('/');
    const isUnique = duplicates.every(d => {
      const dSegments = d.split(/[/\\]/);
      return dSegments.slice(-i).join('/') !== shortPath || d === file;
    });
    if (isUnique) return shortPath;
  }
  
  return file; // Fallback to full path
};
```

Use in the file list:
```tsx
<For each={props.workingFiles}>
  {(file) => (
    <div class="flex items-center gap-2 text-xs text-gray-11">
      <File size={12} class="text-gray-9" />
      <span class="truncate" title={file}>
        {getSmartFileName(props.workingFiles, file)}
      </span>
    </div>
  )}
</For>
```

---

### 3. Make files clickable

**File:** `context-panel.tsx`

Wrap file items in buttons that open/focus the file:
```tsx
<For each={props.workingFiles}>
  {(file) => (
    <button
      type="button"
      class="flex items-center gap-2 text-xs text-gray-11 hover:text-gray-12 hover:bg-gray-3 rounded px-1 -mx-1 transition-colors w-full text-left"
      onClick={() => props.onFileClick?.(file)}
      title={`Open ${file}`}
    >
      <File size={12} class="text-gray-9" />
      <span class="truncate">
        {getSmartFileName(props.workingFiles, file)}
      </span>
    </button>
  )}
</For>
```

Add prop to `ContextPanelProps`:
```tsx
onFileClick?: (path: string) => void;
```

Hook implementation suggestion:
- Use `@tauri-apps/plugin-opener` (`openPath` / `revealItemInDir`) similar to `mcp.tsx:154`
- If remote workspace, disable clicks or show toast

---

### 4. Better skill subtitles

**File:** `context-panel.tsx` L262-280

**Current:** Shows `skill.description` (often vague)

**Should show:** The "when to use" trigger phrase from frontmatter

**Note:** Frontmatter parsing happens server-side (`packages/server/src/skills.ts:33`). To show triggers, either:
1) Add a `trigger` field to `SkillCard` by parsing description or a new frontmatter field, or
2) Parse trigger phrases client-side from `description`.

```tsx
<For each={props.skills}>
  {(skill) => {
    const label = humanizeSkill(skill.name) || skill.name;
    // Prefer trigger phrase if available, else truncated description
    const subtitle = skill.trigger ?? skill.description?.slice(0, 60);
    return (
      <div class="flex items-start gap-2 text-xs text-gray-11">
        <Package size={12} class="text-gray-9 mt-0.5" />
        <div class="min-w-0">
          <div class="truncate">{label}</div>
          <Show when={subtitle}>
            <div class="text-[11px] text-gray-9 truncate" title={subtitle}>
              {subtitle}
            </div>
          </Show>
        </div>
      </div>
    );
  }}
</For>
```

---

## Testing

1. Open session → verify only progress, artifacts, skills expanded
2. Add two files with same basename → verify paths differentiate them
3. Click on a file → verify it opens/focuses
4. Check skill subtitles → verify they show useful trigger info
