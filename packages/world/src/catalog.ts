/**
 * What each maintained world accepts on each target, and ready-to-run commands
 * by intent. `pnpm world help <name> --json` publishes this so an agent can
 * choose a world, placement, seed and source in one call instead of reading the
 * recipes. `world up` composes `--source`/`--seed` from the same entries. The
 * world scripts still enforce every rule; tests keep this catalog in step with
 * them and parse every example command.
 */

import type { SourceKind } from "./source.ts";

/** A `--source` spec kind as typed on the command line: `ref:` resolves to a `sha` before launch. */
export type GuideSourceKind = SourceKind | "ref";

export interface WorldTargetGuide {
  /** A `supportedTargets` entry, for example `freestyle/linux`. */
  target: string;
  /** Seeds accepted on this target; empty when the world takes no seed. */
  seeds: readonly string[];
  /** Source kinds accepted on this target. */
  sources: readonly GuideSourceKind[];
  /** What an omitted `--source` means here. Absent when a source is required. */
  defaultSource?: string;
  note?: string;
}

export interface WorldExample {
  intent: string;
  command: string;
}

export interface WorldGuide {
  /** How `world up` composes `--source`/`--seed` for this world. */
  family: "preview" | "web";
  /** `--source` components; `*` is the unnamed default component. */
  components: readonly string[];
  targets: readonly WorldTargetGuide[];
  examples: readonly WorldExample[];
  caveats?: readonly string[];
}

/** The default source of remote previews: what "the latest alpha" means here. */
export const DEFAULT_DEV_SOURCE = "ref:dev: the current origin/dev commit, pinned to its full SHA at launch (the source the alpha channel is built from)";
const DEV = DEFAULT_DEV_SOURCE;
const LOCAL = "local: this checkout, including uncommitted changes";
const DEN_SEEDS = ["fresh", "team", "restricted", "workspace"];
const UP = "pnpm world up";
const DETACH = "--detach --timeout 600000";
const NO_MODELS = "No model credentials are seeded; chat cannot reach a live model until someone adds a provider.";

/** What each seed prepares. Seeds are named scenarios, not arbitrary fixtures. */
export const SEED_MEANINGS: Readonly<Record<string, string>> = {
  fresh: "First launch: nothing is created or signed in; where the world has a Den it opens at signup.",
  team: "A seeded organization owner with demo Slack, Notion, Linear, Google Calendar and Gmail (in-memory Acme Robotics data) plus real Notion and Linear connectors (individual accounts stay unconnected).",
  restricted: "The team seed with Den's canonical restricted desktop policy applied.",
  workspace: "The team seed; with a desktop (preview-full) it is signed in to a workspace with the demo apps ready.",
  blank: "Exact published release bytes with a completely blank, unseeded profile.",
};

/** Placeholders used in example commands. */
export const EXAMPLE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  "<stage>": "a unique name for this preview, for example pr-1234 or alpha-0930; reuse it to reopen the same preview",
  "<full-pushed-sha>": "a full 40-character commit SHA that is pushed to origin",
  "<x.y.z>": "an exact published desktop version, for example 0.18.52",
  "<distribution>": "public, cloud or enterprise",
};

export const WORLD_GUIDES: Readonly<Record<string, WorldGuide>> = {
  "preview-desktop": {
    family: "preview",
    components: ["desktop"],
    targets: [
      { target: "local/host", seeds: ["fresh"], sources: ["local"], defaultSource: LOCAL, note: "A native desktop window on this computer; no Den or account." },
      { target: "daytona/linux", seeds: ["fresh", "blank"], sources: ["sha", "ref", "release"], defaultSource: DEV, note: "Linux Electron in a private noVNC viewer. fresh builds a pushed commit; blank runs exact published release bytes." },
      { target: "daytona/windows", seeds: ["blank"], sources: ["release"], note: "Only an exact published Windows x64 release in a private VM." },
      { target: "freestyle/linux", seeds: ["fresh"], sources: ["sha", "ref"], defaultSource: DEV, note: "Signed-out desktop snapshot of a pushed commit: no Den, releases or --env app settings." },
    ],
    examples: [
      { intent: "Latest dev (alpha) desktop to click around, signed out, on Freestyle", command: `${UP} preview-desktop --place freestyle --stage <stage> ${DETACH}` },
      { intent: "Latest dev (alpha) desktop on Daytona (accepts --env app settings)", command: `${UP} preview-desktop --place daytona --stage <stage> ${DETACH}` },
      { intent: "Exact published Linux release with a blank profile", command: `${UP} preview-desktop --place daytona --stage <stage> --source desktop=release:<x.y.z>/<distribution> --seed blank ${DETACH}` },
      { intent: "Exact published Windows release", command: `${UP} preview-desktop --place daytona --os windows --stage <stage> --source desktop=release:<x.y.z>/<distribution> --seed blank ${DETACH}` },
      { intent: "This checkout as a native desktop window", command: `${UP} preview-desktop --stage <stage>` },
    ],
    caveats: [
      "The desktop app alone: for a signed-in desktop use preview-full --seed workspace.",
      NO_MODELS,
      "Remote desktops are Linux (or a published Windows release), not a macOS parity check.",
    ],
  },
  "preview-den": {
    family: "preview",
    components: ["den"],
    targets: [
      { target: "local/host", seeds: DEN_SEEDS, sources: ["local"], defaultSource: LOCAL, note: "Den on this computer's MySQL and Redis." },
      { target: "daytona/linux", seeds: DEN_SEEDS, sources: ["sha", "ref"], defaultSource: DEV, note: "Den in a private Daytona sandbox." },
    ],
    examples: [
      { intent: "Den signup and onboarding from latest dev", command: `${UP} preview-den --place daytona --stage <stage> --seed fresh ${DETACH}` },
      { intent: "Seeded team administration (demo apps plus real connectors)", command: `${UP} preview-den --place daytona --stage <stage> --seed team ${DETACH}` },
      { intent: "A specific pushed commit", command: `${UP} preview-den --place daytona --stage <stage> --source den=sha:<full-pushed-sha> --seed fresh ${DETACH}` },
    ],
    caveats: ["Den alone: no desktop app. Mail stays in the preview's development outbox."],
  },
  "preview-full": {
    family: "preview",
    components: ["den", "desktop"],
    targets: [
      { target: "local/host", seeds: DEN_SEEDS, sources: ["local"], defaultSource: LOCAL, note: "Den on this computer's MySQL and Redis plus a native desktop window." },
      { target: "daytona/linux", seeds: DEN_SEEDS, sources: ["sha", "ref"], defaultSource: DEV, note: "Two private Daytona sandboxes: Den plus a Linux desktop wired to it. Select a commit with --source den=...; the desktop builds from the same commit." },
    ],
    examples: [
      { intent: "Signed-in desktop workspace against its own Den, latest dev", command: `${UP} preview-full --place daytona --stage <stage> --seed workspace ${DETACH}` },
      { intent: "Team owner desktop with demo Slack, Notion, Linear, Calendar and Gmail", command: `${UP} preview-full --place daytona --stage <stage> --seed team ${DETACH}` },
      { intent: "Den signup plus a first-launch desktop", command: `${UP} preview-full --place daytona --stage <stage> --seed fresh ${DETACH}` },
      { intent: "A specific pushed commit", command: `${UP} preview-full --place daytona --stage <stage> --source den=sha:<full-pushed-sha> --seed workspace ${DETACH}` },
    ],
    caveats: [NO_MODELS, "Does not run on Freestyle; use preview-desktop there for a signed-out desktop."],
  },
  "preview-app-web": {
    family: "web",
    components: ["*"],
    targets: [
      { target: "local/host", seeds: [], sources: ["local"], defaultSource: LOCAL },
      { target: "daytona/linux", seeds: [], sources: ["sha", "ref"], note: "A private signed Daytona URL. A source is required: --source ref:dev or sha:<full-pushed-sha>." },
      { target: "freestyle/linux", seeds: [], sources: ["sha", "ref"], note: "A source is required: --source ref:dev or sha:<full-pushed-sha>." },
    ],
    examples: [
      { intent: "Web app from latest dev on a private Daytona URL", command: `${UP} preview-app-web --place daytona --stage <stage> --source ref:dev ${DETACH}` },
      { intent: "Web app from latest dev on Freestyle", command: `${UP} preview-app-web --place freestyle --stage <stage> --source ref:dev ${DETACH}` },
      { intent: "This checkout's web app", command: `${UP} preview-app-web --stage <stage>` },
    ],
    caveats: ["The source web app and its server, not Den's web UI. No Den or activation is seeded."],
  },
  "acme-web": {
    family: "web",
    components: ["*"],
    targets: [
      { target: "local/host", seeds: [], sources: ["local"], defaultSource: LOCAL },
      { target: "daytona/linux", seeds: [], sources: ["sha", "ref"], defaultSource: DEV },
      { target: "freestyle/linux", seeds: [], sources: ["sha", "ref"], note: "A source is required: --source ref:dev or sha:<full-pushed-sha>." },
    ],
    examples: [
      { intent: "Seeded Acme demo stack from latest dev on Daytona", command: `${UP} acme-web --place daytona --stage <stage> ${DETACH}` },
      { intent: "Seeded Acme demo stack on Freestyle", command: `${UP} acme-web --place freestyle --stage <stage> --source ref:dev ${DETACH}` },
      { intent: "Seeded Acme demo stack from this checkout", command: `${UP} acme-web --stage <stage>` },
    ],
  },
};

/** Seeds a guided world accepts on any target, in catalog order. */
export function guideSeeds(guide: WorldGuide): string[] {
  return [...new Set(guide.targets.flatMap((target) => target.seeds))];
}
