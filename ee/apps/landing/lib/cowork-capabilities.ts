import type { CompareSource } from "./compare";

/**
 * Grouped capability matrix shared by /alternatives/claude-cowork and
 * /alternatives/claude-cowork-3p (page, agent markdown, and tests).
 *
 * Rules for every cell:
 * - `value` is what ships today. Roadmap items are never "yes".
 * - `planned: true` marks an OpenWork gap that is on the public roadmap
 *   (Building, Next, or Preview in packages/docs/roadmap.mdx).
 * - `note` explains any Partial, or a Yes/No a reader could dispute.
 * - `source` is the evidence: an Anthropic docs URL, or an OpenWork path
 *   on this site (`/docs/...` pages are built from packages/docs/*.mdx).
 */

export const capabilitiesCheckedAt = "2026-09-27";

export type Support = "yes" | "partial" | "no";

export type ProductKey = "enterprise" | "thirdParty" | "openwork";

export type CapabilityCell = {
  value: Support;
  note?: string;
  planned?: true;
  source: string;
};

export type CapabilityRow = {
  label: string;
  cells: Record<ProductKey, CapabilityCell>;
};

export type CapabilityGroup = {
  label: string;
  rows: CapabilityRow[];
};

export type CapabilityColumn = { key: ProductKey; label: string };

export const capabilityColumns: CapabilityColumn[] = [
  { key: "enterprise", label: "Claude Enterprise" },
  { key: "thirdParty", label: "Claude on 3P" },
  { key: "openwork", label: "OpenWork" }
];

const A = {
  matrix: "https://claude.com/docs/third-party/claude-desktop/feature-matrix",
  overview: "https://claude.com/docs/third-party/claude-desktop/overview",
  install: "https://claude.com/docs/third-party/claude-desktop/installation",
  config: "https://claude.com/docs/third-party/claude-desktop/configuration",
  extensions: "https://claude.com/docs/third-party/claude-desktop/extensions",
  gateway: "https://claude.com/docs/third-party/claude-desktop/gateway",
  telemetry: "https://claude.com/docs/third-party/claude-desktop/telemetry",
  adminConsole: "https://claude.com/docs/third-party/claude-desktop/admin-console",
  linux: "https://code.claude.com/docs/en/desktop-linux",
  changelog: "https://claude.com/docs/cowork/changelog",
  pricing: "https://claude.com/pricing/enterprise"
} as const;

const yes = (source: string, note?: string): CapabilityCell => (note ? { value: "yes", note, source } : { value: "yes", source });
const partial = (source: string, note: string): CapabilityCell => ({ value: "partial", note, source });
const no = (source: string, note?: string): CapabilityCell => (note ? { value: "no", note, source } : { value: "no", source });
const planned = (cell: CapabilityCell): CapabilityCell => ({ ...cell, planned: true });

export const capabilityGroups: CapabilityGroup[] = [
  {
    label: "Where you use it",
    rows: [
      {
        label: "Desktop app for macOS and Windows",
        cells: { enterprise: yes(A.matrix), thirdParty: yes(A.install), openwork: yes("/docs/start-here/downloads") }
      },
      {
        label: "Desktop app for Linux",
        cells: {
          enterprise: partial(A.linux, "Claude Desktop on Linux is in beta."),
          thirdParty: partial(A.config, "Linux settings are documented, but the 3P install guide lists only macOS and Windows."),
          openwork: yes("/docs/start-here/enterprise-desktop-deployment")
        }
      },
      {
        label: "Full workspace in a web browser",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: no(A.matrix),
          openwork: planned(partial("/docs/cloud/run-in-the-cloud/open-cloud-in-browser", "OpenWork Web is in preview as a paid add-on."))
        }
      },
      {
        label: "Start work from your phone or Slack",
        cells: { enterprise: yes(A.matrix), thirdParty: no(A.matrix), openwork: planned(no("/roadmap")) }
      },
      {
        label: "Your skills and connections inside Claude Code, Codex, and Cursor",
        cells: {
          enterprise: no(A.matrix),
          thirdParty: no(A.matrix),
          openwork: yes("/docs/start-here/connect-openwork-mcp", "One MCP URL carries your organization's skills and connections.")
        }
      }
    ]
  },
  {
    label: "What the agent can do",
    rows: [
      {
        label: "SKILL.md skills and Claude-format plugins",
        cells: { enterprise: yes(A.matrix), thirdParty: yes(A.matrix), openwork: yes("/docs/start-here/do-work-with-it/skills-plugins-and-mcp") }
      },
      {
        label: "MCP connectors with OAuth, set up once for everyone",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: yes(A.extensions, "Admins push managed MCP servers, including OAuth, by console or MDM."),
          openwork: yes("/docs/cloud/share-with-your-team/shared-mcp-connections")
        }
      },
      {
        label: "Built-in browser the agent drives",
        cells: { enterprise: yes(A.matrix), thirdParty: yes(A.matrix), openwork: yes("/docs/start-here/do-work-with-it/control-the-browser") }
      },
      {
        label: "Artifacts and interactive app views",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: yes(A.matrix),
          openwork: planned(partial("/roadmap", "Artifacts ship today; live artifacts and MCP Apps are in preview."))
        }
      },
      {
        label: "Memory across chats",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: yes(A.matrix, "Stored on the device. Chat-history search is not available on 3P."),
          openwork: partial("/docs/start-here/do-work-with-it/cross-chat-memory", "The agent can search and read past chats when asked; nothing is remembered automatically.")
        }
      },
      {
        label: "Isolated sandbox for agent commands",
        cells: {
          enterprise: yes(A.overview),
          thirdParty: yes(A.overview),
          openwork: partial("/roadmap", "Docker or microsandbox workspaces, with platform and setup limits.")
        }
      }
    ]
  },
  {
    label: "Automations",
    rows: [
      {
        label: "Scheduled and triggered tasks",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: yes(A.matrix),
          openwork: planned(partial("/docs/changelog", "Automations run on a schedule; event triggers are next."))
        }
      },
      {
        label: "Keeps running with your laptop closed",
        cells: {
          enterprise: yes(A.changelog, "Scheduled tasks can move to the cloud."),
          thirdParty: no(A.overview, "Sessions run on the device."),
          openwork: planned(partial("/docs/changelog", "Automations can run in OpenWork Cloud where enabled; hosted workspaces are in progress."))
        }
      },
      {
        label: "Run history, retries, and approvals",
        cells: {
          enterprise: yes(A.changelog),
          thirdParty: yes(A.changelog),
          openwork: planned(partial("/docs/changelog", "Automations keep receipts and recover missed runs; full run history and approvals are next."))
        }
      }
    ]
  },
  {
    label: "Control and deployment",
    rows: [
      {
        label: "Any model, including open-weight and self-hosted",
        cells: {
          enterprise: no(A.pricing),
          thirdParty: partial(A.gateway, "Claude models; others only through an Anthropic-compatible gateway you run."),
          openwork: yes("/docs/start-here/connect-your-stack/use-local-models")
        }
      },
      {
        label: "Prompts stay in your cloud, vendor telemetry off",
        cells: {
          enterprise: no(A.overview, "Inference runs on Anthropic's API."),
          thirdParty: yes(A.telemetry, "On Bedrock or Vertex. On Foundry, Anthropic processes conversations."),
          openwork: yes("/docs/start-here/outbound-network-access")
        }
      },
      {
        label: "Share skills, plugins, and MCP servers with your team",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: partial(A.extensions, "Through a plugin marketplace you host in git or over HTTPS, plus MDM."),
          openwork: yes("/docs/cloud/share-with-your-team/collections")
        }
      },
      {
        label: "SSO, SCIM, teams, and custom roles",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: partial(A.adminConsole, "Through the Enterprise Admin Console, which is in beta and hosted by Anthropic."),
          openwork: yes("/docs/cloud/members-and-rbac")
        }
      },
      {
        label: "Desktop policies and version control",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: yes(A.config),
          openwork: planned(
            partial("/docs/changelog", "Allowed desktop versions are enforced; other policies are paused while they are redesigned.")
          )
        }
      },
      {
        label: "Spend limits per team or person",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: partial(A.adminConsole, "Per-user token limits; dollar budgets live in your cloud or gateway."),
          openwork: yes("/docs/ai-gateway/overview")
        }
      },
      {
        label: "Usage analytics, OpenTelemetry, and audit log",
        cells: {
          enterprise: yes(A.matrix),
          thirdParty: partial(A.matrix, "OpenTelemetry export; no Analytics or Compliance API."),
          openwork: planned(partial("/docs/cloud/security-and-operations", "Usage analytics and audit events ship; OpenTelemetry coverage is in progress."))
        }
      },
      {
        label: "Self-host the control plane, with open source code",
        cells: { enterprise: no(A.overview), thirdParty: no(A.adminConsole), openwork: yes("/docs/start-here/self-host") }
      }
    ]
  }
];

/** Seat price shown under the totals; not a Yes/No capability. */
export const seatPrice: Record<ProductKey, string> = {
  enterprise: "$20 + usage",
  thirdParty: "No seat fee",
  openwork: "Free, or from $10"
};

export const capabilitySources: CompareSource[] = [
  { label: "3P feature matrix", href: A.matrix },
  { label: "3P overview", href: A.overview },
  { label: "3P plugins and MCP", href: A.extensions },
  { label: "Claude Desktop on Linux", href: A.linux },
  { label: "Claude Enterprise pricing", href: A.pricing },
  { label: "OpenWork roadmap", href: "/roadmap" },
  { label: "OpenWork pricing", href: "/docs/start-here/pricing-and-licensing" }
];

export const capabilityRows: CapabilityRow[] = capabilityGroups.flatMap((group) => group.rows);

export type SupportTotals = { yes: number; partial: number; no: number; total: number };

export function supportTotals(key: ProductKey, rows: CapabilityRow[] = capabilityRows): SupportTotals {
  const count = (value: Support) => rows.filter((row) => row.cells[key].value === value).length;
  return { yes: count("yes"), partial: count("partial"), no: count("no"), total: rows.length };
}

export function plannedCount(key: ProductKey, rows: CapabilityRow[] = capabilityRows): number {
  return rows.filter((row) => row.cells[key].planned).length;
}

export function supportLabel(value: Support): string {
  if (value === "yes") return "Yes";
  if (value === "partial") return "Partial";
  return "No";
}

export function totalsText(totals: SupportTotals): string {
  return totals.partial > 0 ? `${totals.yes} (+${totals.partial} partial)` : `${totals.yes}`;
}

export function capabilitySubtitle(): string {
  return `${capabilityRows.length} capabilities, checked against each vendor's own docs. Yes, Partial, or No for what ships today.`;
}

/** Footnote numbers for cells with a note, in reading order. */
export function capabilityFootnotes(): { id: string; number: number; note: string; source: string }[] {
  const notes: { id: string; number: number; note: string; source: string }[] = [];
  for (const row of capabilityRows) {
    for (const column of capabilityColumns) {
      const cell = row.cells[column.key];
      if (cell.note) notes.push({ id: footnoteId(row, column.key), number: notes.length + 1, note: cell.note, source: cell.source });
    }
  }
  return notes;
}

export function footnoteId(row: CapabilityRow, key: ProductKey): string {
  return `${row.label}:${key}`;
}

function absolute(href: string): string {
  return href.startsWith("/") ? `https://openworklabs.com${href}` : href;
}

/** The matrix as GitHub-flavoured markdown for agent views. */
export function capabilityMarkdown(): string {
  const footnotes = new Map(capabilityFootnotes().map((note) => [note.id, note.number]));
  const cellText = (row: CapabilityRow, key: ProductKey) => {
    const cell = row.cells[key];
    const number = footnotes.get(footnoteId(row, key));
    return `${supportLabel(cell.value)}${cell.planned ? " (planned)" : ""}${number ? ` [${number}]` : ""}`;
  };
  const header = `| Capability | ${capabilityColumns.map((column) => column.label).join(" | ")} |`;
  const divider = `|---|${capabilityColumns.map(() => "---").join("|")}|`;
  const body = capabilityGroups.flatMap((group) => [
    `| **${group.label}** |${capabilityColumns.map(() => " ").join("|")}|`,
    ...group.rows.map((row) => `| ${row.label} | ${capabilityColumns.map((column) => cellText(row, column.key)).join(" | ")} |`)
  ]);
  const totals = `| **Yes, of ${capabilityRows.length}** | ${capabilityColumns.map((column) => totalsText(supportTotals(column.key))).join(" | ")} |`;
  const price = `| Price per person, per month | ${capabilityColumns.map((column) => seatPrice[column.key]).join(" | ")} |`;
  const notes = capabilityFootnotes().map((note) => `${note.number}. ${note.note} ([source](${absolute(note.source)}))`);
  return [
    capabilitySubtitle(),
    "",
    header,
    divider,
    ...body,
    totals,
    price,
    "",
    "Planned means the OpenWork gap is on the [public roadmap](https://openworklabs.com/roadmap) and is not counted as Yes.",
    "",
    ...notes,
    "",
    `Checked ${capabilitiesCheckedAt}: ${capabilitySources.map((source) => `[${source.label}](${absolute(source.href)})`).join(", ")}.`
  ].join("\n");
}
