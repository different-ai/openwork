# Feature intros (`featureIntros`)

- **Feature key:** `featureIntros`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @OmarMcAdam
- **Design rules:** [DESIGN.md › Feature intros (I1–I10)](../../../DESIGN.md#feature-intros-onboarding-and-info)

## What people get

Every Den page, sub-page and tab explains itself while it has nothing set up,
instead of a bare "No items yet":

- **Full screen** when nothing in the section is set up: icon, title, one-line
  value, short paragraph or highlights, one action that leads straight to the
  setup step, "Read the docs", and a small live example built from sample data.
- **Info box** (max 600px) where the list would be, when a tab or sub-page is
  not set up but the rest of the section is.
- **Banner** (max 300px tall) at the top of a partly set-up page; it can be
  dismissed for 30 days.
- A quiet neutral **dot** on tabs and sidebar items whose intro the member has
  not seen yet (cleared for 30 days once seen).
- A **`?`** button in the top bar that reopens the current page's intro.

The action depends on who is looking (I6): an admin is offered the setup step,
someone who cannot set it up sees a locked action with who can.

## Who sees it

Every member of an organization where the feature is on. State is stored per
member and per organization, so joining a second organization shows the intros
again there.

## Storage and API

Table `feature_intro_state` (one row per organization, member and intro key):
first seen, last seen, dismissed, action clicked, completed, and the intro
version. Bumping an intro's version in the den-web registry shows it again to
everyone.

- `GET /v1/me/feature-intros` → `{ intros: FeatureIntroState[] }` for the
  current member in the active organization.
- `POST /v1/me/feature-intros/events` with
  `{ introKey, introVersion, type: "seen" | "dismissed" | "cta_clicked" }` →
  `{ intro }`. A newer `introVersion` resets the stored timestamps first; an
  older one changes nothing.

Both routes answer 404 `feature_disabled` while the feature is off. Contract:
`packages/types/src/den/feature-intros.ts`
(`@openwork/types/den/feature-intros`).

## Try it locally

Start den-api with the operator lock on (or turn it on for your organization
in `/admin` › Features):

```sh
DEN_FEATURE_FEATURE_INTROS=true
```

Then open any Den page that has nothing set up yet, e.g. AI Gateway in a new
organization.

## Off

Turning it off (kill switch or organization override) brings back the previous
empty states and hides dots and the `?` button. The API answers 404, so den-web
stops recording events. Stored rows are kept and are used again if the feature
is turned back on; nothing else reads them. Safe to turn off at any moment.

## What to watch

- 4xx/5xx on `/v1/me/feature-intros*` in den-api logs.
- `/admin` › Features usage for `featureIntros` (gated routes count as use).
- Funnel per intro from the table: seen → action clicked → completed.
