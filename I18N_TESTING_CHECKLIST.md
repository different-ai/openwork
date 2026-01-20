# i18n Smoke Test Checklist

This checklist helps reviewers verify the internationalization (i18n) implementation works correctly across all supported languages.

## Supported Languages
- English (en) - Default
- 简体中文 (zh) - Simplified Chinese
- 日本語 (ja) - Japanese
- 한국어 (ko) - Korean
- Español (es) - Spanish
- العربية (ar) - Arabic
- 繁體中文（台灣）(zh-tw) - Taiwan Traditional Chinese
- 繁體中文（香港）(zh-hk) - Hong Kong Traditional Chinese
- Português (pt) - Portuguese

## Testing Instructions

### 1. Language Switching Test (Settings View)

**Steps:**
1. Launch the application
2. Navigate to Settings tab
3. Find the "Language" section
4. Click "Change" button to cycle through languages

**Expected Results:**
- ✅ Language name displays correctly in native script (e.g., "中文", "日本語")
- ✅ Language description updates appropriately
- ✅ Each click advances to the next language
- ✅ After 9 clicks, cycles back to English
- ✅ Selected language persists after app restart

**Test All Languages:**
- [ ] English → Language name: "English", Description: "English (US)"
- [ ] 简体中文 → Language name: "中文", Description: "简体中文"
- [ ] 日本語 → Language name: "日本語", Description: "日本語"
- [ ] 한국어 → Language name: "한국어", Description: "한국어"
- [ ] Español → Language name: "Español", Description: "Spanish"
- [ ] العربية → Language name: "العربية", Description: "Arabic"
- [ ] 繁體中文（台灣） → Language name: "繁體中文（台灣）", Description: "Taiwan Traditional Chinese"
- [ ] 繁體中文（香港） → Language name: "繁體中文（香港）", Description: "Hong Kong Traditional Chinese"
- [ ] Português → Language name: "Português", Description: "Portuguese"

### 2. Onboarding View Test

**Steps:**
1. Reset app data (or fresh install)
2. Launch application to enter onboarding
3. Cycle through each language during onboarding
4. Verify onboarding text is translated

**Expected Results:**
- ✅ Mode selection screen text is translated
- ✅ Host/client setup instructions are translated
- ✅ Connection button text is translated
- ✅ Technical terms remain in English (OpenCode, MCP, Skills, etc.)

**Critical Onboarding Strings:**
- [ ] Mode selection: "Host mode" / "Client mode"
- [ ] Host setup: "Local Engine" / "Stop engine"
- [ ] Connection status: "Connected" / "Disconnected" / "Live"
- [ ] Error messages (if any): Should show translated text with stable keys

### 3. Dashboard View Test

**Steps:**
1. Complete onboarding (or skip with existing setup)
2. Navigate to Dashboard
3. Test language switching in Dashboard view
4. Check each tab for translations

**Expected Results:**
- ✅ Tab names are translated (Home, Sessions, Templates, Skills, Plugins, MCPs, Settings)
- ✅ Connection status in sidebar is translated
- [ ] "Home" tab
  - ✅ "What should we do today?" heading is translated
  - ✅ "New Task" button text is translated
  - ✅ "Quick Start Templates" section heading is translated
- [ ] "Sessions" tab
  - ✅ "Recent Sessions" heading is translated
- [ ] "Templates" tab
  - ✅ All template-related UI is translated
- [ ] "Skills" tab
  - ✅ "Skills" tab name remains in English (technical term)
  - ✅ "Install Skills" button text is translated
  - ✅ Technical paths like `github:anthropics/claude-code` remain in English
- [ ] "Plugins" tab
  - ✅ Plugin-related UI is translated
- [ ] "MCPs" tab
  - ✅ "MCPs" tab name remains in English (technical term)
  - ✅ MCP-related UI is translated
- [ ] "Settings" tab
  - ✅ All settings sections are translated

### 4. Settings View Test

**Steps:**
1. Navigate to Settings tab
2. Test each section for proper translations

**Expected Sections:**
- [ ] **Connection Section**
  - ✅ "Connection" heading
  - ✅ "Enable/Disable Developer Mode" button
  - ✅ "Stop engine" / "Disconnect" button
  - ✅ Engine source labels ("PATH", "Sidecar")

- [ ] **Language Section** ⭐
  - ✅ "Language" heading
  - ✅ "Choose your preferred language" description
  - ✅ Language name displays in native script
  - ✅ "Change" button cycles through all 9 languages

- [ ] **Model Section**
  - ✅ "Model" heading
  - ✅ Model labels and refs
  - ✅ "Thinking" toggle label
  - ✅ "Model variant" section

- [ ] **Demo Mode Section**
  - ✅ "Demo mode" heading
  - ✅ Demo sequence buttons

- [ ] **Updates Section**
  - ✅ "Updates" heading
  - ✅ Update status messages
  - ✅ "Check" / "Download" / "Install & Restart" buttons

- [ ] **Startup Section**
  - ✅ "Startup" heading
  - ✅ Mode labels ("host mode" / "client mode")
  - ✅ "Switch" button

- [ ] **Advanced Section (Developer Mode only)**
  - ✅ "Advanced" heading
  - ✅ "OpenCode cache" label
  - ✅ "Repair cache" button

### 5. Error Messages Test

**Steps:**
1. Trigger an OpenCode cache error (if possible)
2. Or simulate error conditions
3. Verify error messages are properly translated

**Expected Results:**
- ✅ Error message uses translation key `error.cacheCorruptedHint`
- ✅ Technical terms in error remain in English:
  - "OpenCode"
  - "Repair cache"
  - "Settings"
- ✅ Error message is clear and actionable in user's language

**Example Error Message (English):**
```
OpenCode cache looks corrupted. Use Repair cache in Settings to rebuild it.
```

**Verify in Other Languages:**
- [ ] 中文: OpenCode 缓存似乎已损坏...
- [ ] 日本語: OpenCode キャッシュが破損しているようです...
- [ ] 한국어: OpenCode 캐시가 손상된 것 같습니다...
- [ ] (Check other languages similarly)

### 6. Technical Terms Verification

**Critical: These terms MUST remain in English across all languages:**

- ✅ **OpenCode** - Product name
- ✅ **MCP** / **MCPs** - Model Context Protocol
- ✅ **Skills** - Feature name
- ✅ **Plugins** - Feature name
- ✅ **CLI** - Command Line Interface
- ✅ **PATH** - System path
- ✅ **Sidecar** - Architecture pattern
- ✅ **Model IDs** - e.g., "big-pickle", "high", "maximal"
- ✅ **Provider IDs** - e.g., "opencode", "openai", "anthropic"
- ✅ **URLs** - e.g., `https://opencode.ai/install`
- ✅ **File paths** - e.g., `.opencode/skill`, `github:anthropics/claude-code`
- ✅ **Config keys** - e.g., `openwork.language`, `openwork.defaultModel`

**Verify in translations:**
- [ ] Check Chinese (zh) - Skills/MCP should be English
- [ ] Check Japanese (ja) - Skills/MCP should be English
- [ ] Check Arabic (ar) - Skills/MCP should be English (with appropriate script)
- [ ] (Verify other languages)

### 7. localStorage Persistence Test

**Steps:**
1. Change language to any non-English language (e.g., 中文)
2. Fully close the application
3. Relaunch the application
4. Navigate to Settings

**Expected Results:**
- ✅ Language preference persists
- ✅ App loads in the previously selected language
- ✅ No errors in console related to language loading

**Test Multiple Cycles:**
- [ ] English → 中文 → Close → Reopen → Verify 中文
- [ ] 中文 → 日本語 → Close → Reopen → Verify 日本語
- [ ] 日本語 → English → Close → Reopen → Verify English

### 8. Right-to-Left (RTL) Language Test

**Arabic-Specific Tests:**
- [ ] UI layout mirrors correctly for RTL (if applicable)
- [ ] Text renders properly in Arabic script
- [� Technical terms (OpenCode, MCP, Skills) display correctly within Arabic text
- [ ] URLs and English text flow in correct direction (LTR within RTL)

### 9. Accessibility & Font Rendering

**Check Each Language:**
- [ ] **Chinese (zh/zh-tw/zh-hk)**: CJK characters render correctly, not missing boxes
- [ ] **Japanese (ja)**: Kanji and kana render correctly
- [ ] **Korean (ko)**: Hangul renders correctly
- [ ] **Arabic (ar)**: Arabic script renders correctly, text aligns properly
- [ ] **All languages**: No fallback to system default font causing rendering issues

### 10. Edge Cases

**Test Invalid Language in localStorage:**
1. Open browser DevTools
2. Manually set `localStorage.setItem("openwork.language", "invalid-lang")`
3. Reload application

**Expected Results:**
- ✅ App defaults to English
- ✅ No crashes or errors
- ✅ `isLanguage()` helper rejects invalid value

**Test Missing Translation Key:**
1. If any translation key is missing
2. Should fall back to the key name itself (e.g., "tab.newfeature")

## Performance & Code Quality

- [ ] No performance degradation when switching languages
- [ ] Language switching updates UI reactively (no full page reload needed)
- [ ] TypeScript compilation succeeds: `pnpm typecheck`
- [ ] Web build succeeds: `pnpm build:web`
- [ ] No console warnings or errors related to i18n

## Integration Checklist

- [ ] `isLanguage()` helper function exists in `src/i18n/index.ts`
- [ ] `isLanguage()` used in `src/App.tsx` for validation
- [ ] All error messages use stable translation keys
- [ ] Technical terms preserved in English across all translations
- [ ] Language preference stored in `localStorage` with key `openwork.language`
- [ ] Translation files follow consistent structure
- [ ] This checklist exists in repository for future reference

## Quick Smoke Test (5 minutes)

For a quick verification, test these 3 scenarios:

1. **Language Switching**: Settings → Change language 2-3 times → Verify UI updates ✅
2. **Persistence**: Change language → Close app → Reopen → Verify language saved ✅
3. **Technical Terms**: Check Skills tab in Chinese/Japanese → Verify "Skills" is English ✅

If all 3 pass, the i18n implementation is working correctly!

---

## Notes for Reviewers

- Focus on functionality over perfect translations
- Technical terms in English is intentional and correct
- Translation quality can be improved in follow-up PRs
- This PR focuses on infrastructure and basic translations
- Future work can expand translation coverage to more strings

## Known Limitations

- Not all strings are translated yet (focus on critical user-facing strings)
- Some hardcoded strings may remain in English (acceptable for v1)
- Date/time formatting not yet localized
- Number formatting not yet localized
- Keyboard shortcuts not yet localized

---

**Last Updated**: 2025-01-20
**PR**: feat(i18n): Add comprehensive internationalization support
**Languages Supported**: 9 (en, zh, ja, ko, es, ar, zh-tw, zh-hk, pt)
