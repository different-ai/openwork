# Open Outlook, Open Calendar and Open Drive: UI references

Open Outlook, Open Calendar and Open Drive follow the real Outlook on the web and OneDrive screens listed below, with the Acme Robotics sample data.

## Official references

- [Outlook on the web](https://support.microsoft.com/en-us/office/get-help-with-outlook-on-the-web-cf659288-35cc-4c6c-8c75-e8e4317fda11): app rail, folders, sender-focused message list, reading pane and command bar.
- [Upload and save files and folders to OneDrive](https://support.microsoft.com/en-us/office/upload-and-save-files-and-folders-to-onedrive-a1397e56-61ec-4ed2-9dac-727bf8ac3357): file table, upload/folder commands and folder navigation.

## Implemented behavior

Outlook supports shared-state draft/reply/send (synthetic delivery only), archive, soft delete/restore, read/unread state, unread filtering, sender search, calendar reads and event creation. OneDrive supports shared-state file/folder navigation and creation, file upload/download, sorting, text preview/editing, and stale-eTag protection. Polling preserves in-progress compose state and reflects MCP-side writes.

Office files are real OOXML downloads. Their browser surfaces explicitly show **read-only extracted text**, not Word/Excel/PowerPoint editing. Full editing remains a Documents/Collabora integration gap.

The fixture intentionally uses native accessible controls and fixture-local semantic CSS variables rather than introducing a React build/dependency into the single-file service (DESIGN P5 exception). Applied P1/P6/P10/P11, S1/S2, C1/C2/C6 and V5; no placeholder controls are presented as working Microsoft features.

## Verification

```sh
pnpm --dir evals exec vitest run --config vitest.config.ts --project pr packages/open-workplace/src/microsoft365.test.ts
OPEN_WORKPLACE_SCREENSHOT_DIR=evals/results/open-workplace/microsoft365 \
  node --test evals/packages/open-workplace/src/microsoft365-ui.test.mjs
```

The actual headless-Chrome test covers reading, compose/reply/draft/send, folder/read-state mutations, calendar creation, MCP-side polling with focus continuity, Office downloads and byte-exact uploads, text editing, and stale-eTag handling. It emits seven real 1440×1000 screenshots when requested. Screenshots and runtime receipts are not committed.
