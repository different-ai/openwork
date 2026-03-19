# Session view sans font proof

- Change: removed `font-serif` from assistant message container in session view.
- File: `packages/app/src/app/components/session/message-list.tsx`
- Screenshot: `packages/app/pr/session-view-sans-font-proof.png`
- Verification command:

```bash
git grep -n "font-serif" packages/app/src/app/components/session/message-list.tsx
```

Expected result: no matches.
