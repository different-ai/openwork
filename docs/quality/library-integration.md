# Library presentation rollout

`libraryIntegrated` is off by default on cloud and self-hosted. It changes presentation only: disabling it restores the original rows, headings and picker while retaining plugins, connector accounts, grants and routes.

## Observed differences

The existing `den-manage-plugins` and `library-list-on-wide-screens` journeys provide the before screenshots. Den's Members and Connectors screens are recorded in the same organization for comparison; Settings uses `/dashboard/org-settings`.

| Surface | Before | Flagged presentation |
| --- | --- | --- |
| Plugins list | A growing search field, duplicate counts, non-numeric column labels and a repeated sort-order note; forced 760px minimum width | Shared `FilterInput` and `ItemRow`, a compact heading, plain Private/Shared state and one trailing menu; bounded pagination and virtualization remain |
| My Library | Single-line name, separate Kind and sharing columns; description only on hover; readiness represented by a dot | Name over description, Ready/Sign in/Set up words, the shared row and action lane; access remains on the detail page |
| Empty Plugins | Two Create a plugin actions and unrelated service marks on an empty plugin collection | One action, a short invitation and the private-until-shared state |
| Plugin detail | A 28px heading, description under it and content counts | Compact shared heading; description and object metadata in Details; unchanged sharing controls |
| Contents and skill detail | Separate boxed headers, green skill tile, nested body boxes and a separate Delete confirmation implementation | Shared header, mark, rows and Remove confirmation; authored skill text and version-history behavior remain unchanged |
| Add picker | Explanatory subtitle, repeated logo strip and a second explanatory footer | Shared compact rows, selection check and one quiet ownership note; the same choices, Continue, Cancel and destinations |
| Named-service plugins | Letter tile even when the name is an actual recognized service | Existing brand resolver; ordinary user-created plugins still use a neutral letter tile |
| Desktop list | Name/Kind/From/What it does columns and non-numeric column headings; state hidden or a dot | Same name-over-description anatomy at desktop density, visible state words and straight action lanes; desktop chrome and actions retained |
| Desktop skill detail | Colored fallback mark, tiny filled state chips, boxed heading, internally scrolling instructions and a file path in the default viewport | Neutral mark and readable state word, compact flat content and sentence-case instructions; the complete file path remains under Technical details |

The desktop add action already lives in its collection toolbar, so it is not moved. Generic user-created names are not treated as brands. Legacy Sources and workflow editors retain their purpose and are not redesigned by this rollout.

## Proof

`den-manage-plugins.e2e.test.ts` records off/on empty, list, plugin and skill detail, and add flow, plus a Sales member without manage permission. The owner turns the rollout off through the existing admin controls and the same plugin and Sales grant remain available. Narrow list proof uses a 320px window.

`library-list-on-wide-screens.e2e.test.ts` retains the off journey and adds a signed-in, organization-flagged desktop-web journey at wide and laptop sizes, including detail and the existing add picker.

Design: P3, P4, P5, P10, S1, S2, C1, C5, C6, V1, V2, V5; OW-LIST, OW-LIST-HEADER, OW-STATE, OW-ADD, OW-EMPTY, OW-CONFIRM.
