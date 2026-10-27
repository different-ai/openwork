# Open Jira and Open Confluence: UI references

Open Jira and Open Confluence follow the real Jira and Confluence Data Center screens listed below, with the Acme Robotics sample data. Screenshots produced by the browser test are captures of the running local service.

## Official references consulted

- [Jira list view](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-list-view/) — list/table density, issue fields and project-scoped work.
- [View a Jira work item](https://support.atlassian.com/jira-software-cloud/docs/view-a-work-item/) — issue detail and editable fields.
- [Navigate Confluence spaces](https://support.atlassian.com/confluence-cloud/docs/navigate-spaces/) — space navigation, nested content, directory filtering.
- [View a Confluence page](https://support.atlassian.com/confluence-cloud/docs/view-a-page/) — reading surface and page metadata.
- [Official Confluence space directory screenshot](https://images.ctfassets.net/zsv3d0ugroxu/3pUbmgUGEJVBTyKKb3rEzY/d79e6527b448cabf852f185f3e4bd1b1/ConfluenceCloud_AllSpaces) — downloaded and visually reviewed locally. Not checked into the repository or displayed by the fixture.
- [Official Confluence navigation screenshot](https://images.ctfassets.net/zsv3d0ugroxu/5ZchROVMzhdA9TMZOmPeEk/c42858dfe3bca866968ac794f74b145a/screenshot_StarredSpaces_Nav4.jpg) — linked from the official navigation documentation.
- [Jira product mark](https://images.ctfassets.net/zsv3d0ugroxu/3tdm6nuuJrPlizPLgkWqZ5/d0a7942804abf2f8f6737197be1fc7f4/logo-light_Jira_mark_brand_RGB.svg) and [Confluence product mark](https://images.ctfassets.net/zsv3d0ugroxu/5VucmXIhBRYyBXA9ygFJ3Y/5082d769a81934af185dcf109b29f628/logo-light_Confluence_mark_brand_RGB.svg) — fetched from Atlassian's support pages; their path geometry is embedded locally, with no runtime asset requests.

This is an Atlassian-inspired, deliberately bounded fixture, not a pixel-identical recreation of every product version. Cloud navigation references inform the presentation; existing Data Center REST contracts remain unchanged. Unsupported capabilities such as releases, notifications, attachments, sharing, watching, and administrative settings do not appear as dead controls.

## Implemented interactions

- Jira: project navigation/deep links, list and board views, project/status/assignee filters, updated/key sorting, search, issue creation with project context, issue summary/description editing, safe Jira wiki heading/emphasis/list/code rendering, comments, status transitions, priority and assignee changes.
- Confluence: space-scoped search, linked ancestors, native nested page disclosures, selected-page state, preserved disclosure state across polling, real document heading anchors, metadata, labels, safe rich-text editing and version-aware saves.
- The board is a projection of shared REST issue state. Cards open real issue detail; it does not pretend to offer drag-and-drop.
- Polling preserves drafts and focus, reflects agent-side writes, and keeps the last known document visible when the backend is offline.
- Native inputs, selects, buttons, dialogs and details are intentional in this dependency-free Node fixture (DESIGN P5 exception); no React build or additional dependencies were installed.

Design rules applied: P1 (actual state), P6 (data density), P7 (issue/document focal element), P10 (actual browser evidence), P11 (draft continuity), S1/S2 (flat compact lists), S3 (native disclosure), C1/C2 (outcome labels), C6 (recoverable offline notice), V5 (product marks and navigation icons), V6 (reduced motion). Fixture-local semantic CSS variables retain its standalone execution model.

## Verification handoff

Command (local working tree, actual headless Chrome):

```sh
OPEN_WORKPLACE_SCREENSHOT_DIR="$EVIDENCE_DIR" node --test evals/packages/open-workplace/src/atlassian-web.test.mjs
```

Latest result: exit 0; **2 passed, 0 failed, 0 skipped**. No install was needed. The proof covers shared REST state, proxy/CSRF guards, project board deep links and filters, search/empty state, native dialog Escape/focus return, create/edit/comment/transition/assignment/priority writes, agent-side polling, draft/caret preservation, space filters, disclosure persistence, document editing/cancel, sanitization, real heading links, and offline last-known-state retention. No browser runtime exceptions were observed.

Actual 1440×1000 captures are emitted when `OPEN_WORKPLACE_SCREENSHOT_DIR` is set:

- `jira-issues.png`
- `jira-project-board.png`
- `jira-project-board-filtered.png`
- `jira-create-dialog.png`
- `jira-created-issue.png`
- `jira-updated-issue.png`
- `confluence-it-policy.png`
- `confluence-handbook.png`
- `confluence-offline.png`

Captures are local artifacts and are not committed. This browser test alone is not an end-to-end verdict.
