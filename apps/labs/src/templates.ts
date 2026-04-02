import type {
  LabsBlueprint,
  LabsBlueprintSessionTemplate,
  LabsStarter,
  LabsTemplateProfile,
  MaterializedSessionBinding,
  SeedMessage,
} from "./types";

const DEFAULT_EMPTY_STATE = {
  title: "What do you want to do?",
  body: "Pick a starting point or just type below.",
};

type BundleWorkspace = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function slugify(value: string) {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return compact.replace(/^-+|-+$/g, "") || "template";
}

function normalizeSeedMessage(value: unknown): SeedMessage | null {
  const record = asRecord(value);
  if (!record) return null;

  const text = readString(record.text);
  if (!text) return null;

  return {
    role: readString(record.role) === "user" ? "user" : "assistant",
    text,
  };
}

function normalizeStarter(value: unknown, index: number): LabsStarter | null {
  const record = asRecord(value);
  if (!record) return null;

  const title = readString(record.title);
  const description = readString(record.description);
  const kind = readString(record.kind) || "prompt";
  if (!title) return null;

  return {
    id: readString(record.id) || `starter-${index + 1}`,
    kind: kind === "session" || kind === "action" ? kind : "prompt",
    title,
    description,
    prompt: readString(record.prompt) || undefined,
    action: readString(record.action) || undefined,
  };
}

function normalizeBlueprintSession(
  value: unknown,
  index: number,
): LabsBlueprintSessionTemplate | null {
  const record = asRecord(value);
  if (!record) return null;

  const title = readString(record.title);
  const messages = Array.isArray(record.messages)
    ? record.messages
        .map(normalizeSeedMessage)
        .filter((item): item is SeedMessage => Boolean(item))
    : [];

  if (!title && messages.length === 0) return null;

  return {
    id: readString(record.id) || `template-session-${index + 1}`,
    title: title || `Starter session ${index + 1}`,
    messages,
    openOnFirstLoad: record.openOnFirstLoad === true,
  };
}

function normalizeMaterializedSessions(value: unknown): MaterializedSessionBinding[] {
  const record = asRecord(value);
  const sessions = asRecord(record?.sessions);
  const items = Array.isArray(sessions?.items) ? sessions?.items : [];

  return items
    .map((item) => {
      const next = asRecord(item);
      if (!next) return null;
      const templateId = readString(next.templateId);
      const sessionId = readString(next.sessionId);
      if (!templateId || !sessionId) return null;
      return { templateId, sessionId } satisfies MaterializedSessionBinding;
    })
    .filter((item): item is MaterializedSessionBinding => Boolean(item));
}

function sanitizeOpenworkConfig(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;

  const next = cloneRecord(record);
  const blueprint = asRecord(next.blueprint);
  const materialized = asRecord(blueprint?.materialized);
  if (materialized && "sessions" in materialized) {
    delete materialized.sessions;
  }
  if (blueprint && materialized && Object.keys(materialized).length === 0) {
    delete blueprint.materialized;
  }
  return next;
}

function normalizeBlueprint(value: unknown, preset: string): LabsBlueprint {
  const record = asRecord(value);
  const emptyState = asRecord(record?.emptyState);
  const starters = Array.isArray(emptyState?.starters)
    ? emptyState.starters
        .map(normalizeStarter)
        .filter((item): item is LabsStarter => Boolean(item))
    : [];
  const sessions = Array.isArray(record?.sessions)
    ? record.sessions
        .map((item, index) => normalizeBlueprintSession(item, index))
        .filter((item): item is LabsBlueprintSessionTemplate => Boolean(item))
    : [];

  return {
    emptyState: {
      title: readString(emptyState?.title) || defaultEmptyTitle(preset),
      body: readString(emptyState?.body) || defaultEmptyBody(preset),
      starters,
    },
    sessions,
    materialized: normalizeMaterializedSessions(record?.materialized),
  };
}

function presetFromWorkspace(workspace: BundleWorkspace | null) {
  const openwork = asRecord(workspace?.openwork);
  const workspaceConfig = asRecord(openwork?.workspace);
  return readString(workspaceConfig?.preset) || "starter";
}

function defaultEmptyTitle(preset: string) {
  if (preset === "automation") return "What do you want to automate?";
  if (preset === "minimal") return "Start with a task";
  return DEFAULT_EMPTY_STATE.title;
}

function defaultEmptyBody(preset: string) {
  if (preset === "automation") {
    return "Start from a reusable workflow or type your own task below.";
  }
  if (preset === "minimal") {
    return "Ask a question about this workspace or use a starter prompt.";
  }
  return DEFAULT_EMPTY_STATE.body;
}

function describeIncludedItems(workspace: BundleWorkspace | null) {
  if (!workspace) return [] as string[];

  const skills = Array.isArray(workspace.skills) ? workspace.skills.length : 0;
  const commands = Array.isArray(workspace.commands) ? workspace.commands.length : 0;
  const files = Array.isArray(workspace.files) ? workspace.files.length : 0;
  const hasOpenCodeConfig = Boolean(asRecord(workspace.opencode));
  const hasOpenWorkConfig = Boolean(asRecord(workspace.openwork));

  return [
    ...(skills > 0 ? [`${skills} shared skill${skills === 1 ? "" : "s"}`] : []),
    ...(commands > 0 ? [`${commands} reusable command${commands === 1 ? "" : "s"}`] : []),
    ...(files > 0 ? [`${files} template file${files === 1 ? "" : "s"}`] : []),
    ...(hasOpenCodeConfig ? ["Included OpenCode defaults"] : []),
    ...(hasOpenWorkConfig ? ["Included workspace behavior"] : []),
  ];
}

function describeRecommendedDefaults(workspace: BundleWorkspace | null, preset: string) {
  const openwork = asRecord(workspace?.openwork);
  const opencode = asRecord(workspace?.opencode);
  const defaults: string[] = [];

  defaults.push(
    preset === "automation"
      ? "Automation-ready workspace posture"
      : preset === "minimal"
        ? "Minimal starter workspace posture"
        : "Starter workspace posture",
  );

  if (readString(asRecord(opencode)?.model)) {
    defaults.push("Default model recommendation included");
  }

  if (Array.isArray(asRecord(openwork?.blueprint)?.sessions)) {
    defaults.push("Starter chats ready on first load");
  }

  return Array.from(new Set(defaults));
}

type WorkspaceProfileBundle = {
  schemaVersion: number;
  type: string;
  name?: string;
  description?: string;
  workspace?: BundleWorkspace;
};

export function profileFromWorkspaceProfileBundle(
  value: unknown,
  options: { source: "builtin" | "shared"; sourceUrl?: string | null } = {
    source: "shared",
  },
): LabsTemplateProfile {
  const record = asRecord(value) as WorkspaceProfileBundle | null;
  if (!record) {
    throw new Error("Invalid template bundle.");
  }

  if (record.schemaVersion !== 1 || record.type !== "workspace-profile") {
    throw new Error("Only workspace-profile bundles can be used in Labs.");
  }

  const workspace = asRecord(record.workspace);
  if (!workspace) {
    throw new Error("Workspace profile bundle is missing workspace data.");
  }

  const preset = presetFromWorkspace(workspace);
  const openwork = sanitizeOpenworkConfig(workspace.openwork);
  const blueprint = normalizeBlueprint(asRecord(openwork)?.blueprint, preset);
  const sourceUrl = options.sourceUrl?.trim() || null;
  const name = readString(record.name) || "Shared workspace template";

  return {
    id: sourceUrl ? `shared:${sourceUrl}` : `${options.source}:${slugify(name)}`,
    source: options.source,
    sourceUrl,
    dataUrl: sourceUrl,
    name,
    description:
      readString(record.description) ||
      "Start from a guided workspace with reusable defaults, starter chats, and calm onboarding.",
    preset,
    recommendedDefaults: describeRecommendedDefaults(workspace, preset),
    includedItems: describeIncludedItems(workspace),
    starterCount: blueprint.emptyState.starters.length,
    starterSessionCount: blueprint.sessions.length,
    blueprint,
  };
}

export function coerceBundleDataUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const url = new URL(trimmed);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/data")) {
    return url.toString();
  }
  if (/\/b\/[^/]+$/i.test(pathname)) {
    url.pathname = `${pathname}/data`;
    url.search = "";
    return url.toString();
  }
  return url.toString();
}

export async function fetchTemplateProfile(bundleUrl: string) {
  const dataUrl = coerceBundleDataUrl(bundleUrl);
  if (!dataUrl) {
    throw new Error("Enter a bundle URL to preview a shared template.");
  }

  const response = await fetch(dataUrl, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Template fetch failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as WorkspaceProfileBundle;
  const profile = profileFromWorkspaceProfileBundle(payload, {
    source: "shared",
    sourceUrl: dataUrl,
  });

  return {
    ...profile,
    sourceUrl: bundleUrl.trim(),
    dataUrl,
  } satisfies LabsTemplateProfile;
}

export const builtInTemplates: LabsTemplateProfile[] = [
  {
    id: "builtin:weekly-client-follow-up",
    source: "builtin",
    sourceUrl: null,
    dataUrl: null,
    name: "Weekly Client Follow-up",
    description:
      "Start from a guided workspace for planning, drafting, and tracking weekly client outreach.",
    preset: "starter",
    recommendedDefaults: [
      "Calm starter copy for non-technical operators",
      "Seeded follow-up conversations ready on first load",
      "Reusable outreach prompts already framed",
    ],
    includedItems: ["2 starter chats", "3 starter actions", "Follow-up workflow defaults"],
    starterCount: 3,
    starterSessionCount: 2,
    blueprint: {
      emptyState: {
        title: "What do you want to send this week?",
        body: "Start from a follow-up workflow or type your own request.",
        starters: [
          {
            id: "draft-follow-ups",
            kind: "prompt",
            title: "Draft this week's follow-ups",
            description: "Generate first-pass outreach messages with the right tone.",
            prompt:
              "Help me draft this week's client follow-ups. Ask who I should prioritize, then propose concise email drafts.",
          },
          {
            id: "review-client-list",
            kind: "session",
            title: "Review my client list",
            description: "Open a guided chat for prioritizing this week's outreach.",
            prompt:
              "Help me review this week's client list, group the most important follow-ups, and suggest the strongest next action for each.",
          },
          {
            id: "use-template",
            kind: "action",
            title: "Use a shared template",
            description: "Open the template library and pick another ready-made workspace.",
            action: "open-template-library",
          },
        ],
      },
      sessions: [
        {
          id: "welcome-client-follow-up",
          title: "Welcome to Client Follow-ups",
          openOnFirstLoad: true,
          messages: [
            {
              role: "assistant",
              text:
                "Welcome to your weekly client follow-up workspace. I can help you prioritize who needs attention, draft thoughtful messages, and turn loose notes into a clean outreach plan.",
            },
            {
              role: "assistant",
              text:
                "Start with the client you care most about, or pick one of the starter actions below to move faster.",
            },
          ],
        },
        {
          id: "review-contacts",
          title: "Review this week's contacts",
          openOnFirstLoad: false,
          messages: [
            {
              role: "assistant",
              text:
                "Paste your client list, CRM export, or rough notes and I will help you group contacts into follow-ups, warm check-ins, and low-priority replies.",
            },
          ],
        },
      ],
      materialized: [],
    },
  },
  {
    id: "builtin:browser-automation-walkthrough",
    source: "builtin",
    sourceUrl: null,
    dataUrl: null,
    name: "Browser Automation Walkthrough",
    description:
      "Give Susan a calmer starting point for browser-based repetitive work without dropping her into tooling details.",
    preset: "automation",
    recommendedDefaults: [
      "Automation-first starter posture",
      "Browser workflow orientation included",
      "Session starters already framed as guided tasks",
    ],
    includedItems: ["2 starter chats", "2 starter actions", "Automation workspace defaults"],
    starterCount: 2,
    starterSessionCount: 2,
    blueprint: {
      emptyState: {
        title: "What should the browser do for you?",
        body: "Choose a walkthrough or describe the repetitive task in your own words.",
        starters: [
          {
            id: "map-browser-workflow",
            kind: "prompt",
            title: "Map the workflow first",
            description: "Turn a repetitive browser task into a step-by-step automation plan.",
            prompt:
              "Help me map a repetitive browser task into a reliable automation. Start by asking what site I use and which steps feel repetitive.",
          },
          {
            id: "start-browser-session",
            kind: "session",
            title: "Start the browser walkthrough",
            description: "Open a guided conversation for browser automation work.",
            prompt:
              "Walk me through setting up browser automation for a repetitive task. Keep the explanation simple and focused on what I will see next.",
          },
        ],
      },
      sessions: [
        {
          id: "browser-welcome",
          title: "Welcome to Browser Automation",
          openOnFirstLoad: true,
          messages: [
            {
              role: "assistant",
              text:
                "This workspace is tuned for browser automation. Tell me what you click through repeatedly and I will help translate it into a cleaner workflow.",
            },
          ],
        },
        {
          id: "browser-checklist",
          title: "Browser task checklist",
          openOnFirstLoad: false,
          messages: [
            {
              role: "assistant",
              text:
                "A good automation checklist has three parts: what page to open, what information to read, and what action should happen next. Share any one of those to begin.",
            },
          ],
        },
      ],
      materialized: [],
    },
  },
];
