import { ArrowRight, Check, Clock3, LoaderCircle, Mail } from "lucide-react";
import type { ReactNode } from "react";

import { AutomationsView } from "./lp-demo-automations";
import { LpDemoDesktop } from "./lp-demo-desktop";
import { LpDemoAiGateway, LpDemoCloud, LpDemoMcp } from "./lp-demo-panels";
import {
  RoadmapActivityPreview,
  RoadmapDashboardPreview,
  RoadmapInsightsPreview,
  RoadmapPhonePreview,
  RoadmapSlackPreview,
  RoadmapStreamlinedChatPreview,
  RoadmapWorkbotPreview,
  RoadmapWorkflowPreview
} from "./roadmap-previews";

export type RoadmapStatus = "ready" | "building" | "soon";

export type RoadmapProduct = {
  id: string;
  label: string;
  heading: [string, string];
  intro: string;
  items: Record<RoadmapStatus, string[]>;
  /** Ready items that shipped since the last roadmap update; they get a "New" mark. */
  fresh?: string[];
  /** Ready items in preview: the row links to an email asking for access. */
  preview?: string[];
};

/* One entry per product. The status is the column an item sits in, so a
 * reader never has to decode a badge. Keep this in step with
 * packages/docs/roadmap.mdx. */
export const ROADMAP_PRODUCTS: RoadmapProduct[] = [
  {
    id: "desktop",
    label: "Desktop",
    heading: ["The desktop app", "is home."],
    intro: "Work on your own files with any model. Skills, connections, a built-in browser, and computer use, on macOS, Windows, and Linux.",
    items: {
      ready: [
        "macOS, Windows, and Linux",
        "Skills, plugins, and connections",
        "Built-in browser",
        "Files, artifacts, and any model",
        "MCP Apps",
        "Live artifacts",
        "Computer use on Mac and Windows",
        "Import Claude chats and Claude Code sessions",
        "Add your own MCP from the Library",
        "Agents use a website’s own tools",
        "Several agents in their own Mac apps at once",
        "Agents ask a question and keep working",
        "A feed of your sessions across workspaces",
        "Send a follow-up now or queue it",
        "Outlook attachments and drafts",
        "Recurring Google Calendar meetings",
        "Run tasks on your other computers as sub-agents",
        "Background tasks you can follow in the chat",
        "Floating and full-screen browser",
        "History of each computer use session",
        "Focused reading and edits in Google Docs",
        "Zoom into diagrams"
      ],
      building: [
        "Sandboxed workspaces",
        "Pick up work on any device",
        "Dictation",
        "Teach a browser task by showing it once",
        "Suggested next message",
        "Use Claude through your Claude Code login"
      ],
      soon: []
    },
    fresh: [
      "Computer use on Mac and Windows",
      "Import Claude chats and Claude Code sessions",
      "Add your own MCP from the Library",
      "Agents use a website’s own tools",
      "Several agents in their own Mac apps at once",
      "Agents ask a question and keep working",
      "Send a follow-up now or queue it",
      "Outlook attachments and drafts",
      "Recurring Google Calendar meetings",
      "Run tasks on your other computers as sub-agents",
      "Floating and full-screen browser"
    ]
  },
  {
    id: "admin",
    label: "Admin",
    heading: ["You set the rules.", "Every surface follows."],
    intro: "OpenWork Cloud is where admins manage models, spend, policies, and access for every team.",
    items: {
      ready: [
        "AI Gateway for every provider",
        "Usage, spend, and hard limits by team",
        "Desktop policies by team or member",
        "SSO, teams, and roles",
        "Audit logs",
        "AI Gateway in Cursor, Claude Code, and Codex",
        "Smart Model Router",
        "Custom OpenAI-compatible providers",
        "Several SSO connections per organization",
        "Export and import organization config",
        "Admin roles for security and IT",
        "Custom roles for a person or a team",
        "Allow, ask first, or block what agents can do",
        "OpenTelemetry-compatible server logs",
        "Deterministic configs",
        "SCIM provisioning",
        "Session length and admin re-sign-in rules",
        "Usage limits for each provider",
        "Test a provider before adding it",
        "AWS and Microsoft sign-in for model providers",
        "LiteLLM as a provider",
        "A default model for the organization",
        "Organization API keys",
        "Install links and a setup checklist for new members",
        "Sandbox organizations for testing",
        "Managed install in your own AWS or Google Cloud"
      ],
      building: ["Fully managed desktop", "Share a provider key from your device", "Turn local models on or off"],
      soon: []
    },
    preview: ["Managed install in your own AWS or Google Cloud"],
    fresh: [
      "Session length and admin re-sign-in rules",
      "Test a provider before adding it",
      "Admin roles for security and IT",
      "Custom roles for a person or a team",
      "Allow, ask first, or block what agents can do",
      "AI Gateway in Cursor, Claude Code, and Codex",
      "Smart Model Router",
      "Custom OpenAI-compatible providers",
      "Several SSO connections per organization",
      "Export and import organization config"
    ]
  },
  {
    id: "visibility",
    label: "Visibility",
    heading: ["See what works,", "and what doesn’t."],
    intro: "Know which skills, connections, and teams are getting real work done, and which aren’t, so you can show the return on your AI spend.",
    items: {
      ready: [
        "Usage and adoption by person",
        "Spend by team and model",
        "Daily usage trends",
        "Organization activity: who shared and changed what",
        "What’s used, and what isn’t",
        "Workflow runs across the organization"
      ],
      building: ["What cloud agents spend on models"],
      soon: ["Failures by skill and connection", "Results and spend by team"]
    },
    fresh: ["Daily usage trends", "Organization activity: who shared and changed what"]
  },
  {
    id: "mcp-gateway",
    label: "MCP Gateway",
    heading: ["Set up your MCPs once.", "Your whole team has them."],
    intro: "One MCP URL brings your team’s skills, plugins, and connections into Claude Code, Codex, Cursor, and any MCP client.",
    items: {
      ready: [
        "One MCP URL for your whole team",
        "Claude Code, Codex, Cursor, and ChatGPT",
        "Skills, plugins, and connections by team",
        "Shared or per-person sign-in",
        "OneDrive and SharePoint files",
        "Guided Slack setup",
        "More ready-made MCP servers",
        "Sign-in detected for custom MCPs",
        "Slack messages from the OpenWork bot"
      ],
      building: [
        "Sync plugins from Git",
        "One app identity enterprises allowlist once",
        "An MCP server for each connection",
        "Each connected action as its own tool"
      ],
      soon: []
    },
    fresh: ["OneDrive and SharePoint files", "Guided Slack setup", "More ready-made MCP servers", "Sign-in detected for custom MCPs"]
  },
  {
    id: "activity",
    label: "Sharing and activity",
    heading: ["Your team’s best work,", "in everyone’s hands."],
    intro:
      "Make sure your organization uses its latest advances to push further. When someone shares a skill, publishes a new version, or connects an app, the people who can use it hear about it and can try it right away.",
    items: {
      ready: [
        "Share skills and plugins with a team",
        "Company marketplaces",
        "See who can use each plugin",
        "Organization prompts for every agent",
        "Activity: what’s new for you"
      ],
      building: [],
      soon: []
    },
    fresh: ["Organization prompts for every agent", "Activity: what’s new for you"]
  },
  {
    id: "web",
    label: "Web",
    heading: ["The same workspace,", "in your browser."],
    intro: "Everything from the desktop app, running in the cloud. Nothing to install, and work keeps going when you close the tab.",
    items: {
      ready: ["The full workspace in your browser", "Your team’s skills and connections", "Self-hosted OpenWork Web"],
      building: [],
      soon: ["Session sharing"]
    },
    fresh: ["Self-hosted OpenWork Web"]
  },
  {
    id: "workbot",
    label: "Workbot",
    heading: ["An assistant", "for every member."],
    intro: "Workbot works from a chat in your browser or on your phone. It has its own cloud computer that stays on, your team’s skills, and your connected apps.",
    items: {
      ready: [
        "Workbot, an assistant for every member",
        "Workbot on your phone",
        "Always-on cloud workspace",
        "Live browser work in the chat",
        "Watch and take over Workbot’s browser",
        "Workbot reads PDFs and Office files from Drive",
        "Workbot starts tasks on your computers",
        "Working status and a list of what it’s doing",
        "Calendar of Workbot’s scheduled work",
        "Side chats",
        "A background agent for each member",
        "Workbot settings for each team"
      ],
      building: ["Read and edit documents beside the chat"],
      soon: []
    },
    fresh: ["Workbot on your phone", "Always-on cloud workspace", "Live browser work in the chat", "Workbot reads PDFs and Office files from Drive", "Workbot starts tasks on your computers", "Working status and a list of what it’s doing", "A background agent for each member", "Workbot settings for each team"]
  },
  {
    id: "automations",
    label: "Automations",
    heading: ["Set it once.", "It runs on its own."],
    intro: "Schedule any task on the web or the desktop, with the same skills and connections as a normal chat.",
    items: {
      ready: [
        "Schedules on web and desktop",
        "Daily and weekly runs",
        "Missed and interrupted runs are shown",
        "Every-few-hours schedules",
        "Runs before or after a meeting",
        "Cloud runs while your computer is off",
        "Cloud tasks survive restarts and updates",
        "Organization settings for automations"
      ],
      building: [],
      soon: ["Run in the cloud from GitHub events", "Team plan, no OpenWork Web needed", "Fine-grained automation control", "Approvals in the middle of a run"]
    },
    fresh: ["Every-few-hours schedules", "Runs before or after a meeting"]
  },
  {
    id: "workflows",
    label: "Workflows",
    heading: ["Every step,", "out in the open."],
    intro: "Save a task that worked as a workflow. Each step, decision, and result is laid out like a flow, without building it by hand.",
    items: {
      ready: [
        "Live workflows across your connected apps",
        "A step-by-step flow for every workflow",
        "Run history with each step’s result",
        "Save a workflow with a name, find it in My Library",
        "Workflows written as standard JavaScript"
      ],
      building: ["Share workflows with your team"],
      soon: ["Live edit"]
    },
    fresh: ["Save a workflow with a name, find it in My Library"]
  },
  {
    id: "dashboards",
    label: "Dashboards",
    heading: ["What matters today,", "at a glance."],
    intro: "Your people build their own quick views, like today’s meetings or open issues, from the apps they already use. Built on the MCP Apps standard.",
    items: {
      ready: [
        "Quick-glance views your people create", "Works with MCP Apps", "Build Apps from a chat on the desktop", "Open an App as a site, public or signed-in",
        "Public Apps anyone can add, no sign-in",
        "Fix an App with your agent when a tool changes",
        "See an App’s progress while it builds",
        "Built-in libraries for Apps"
      ],
      building: ["Open Apps from the Workbot chat"],
      soon: []
    },
    fresh: [
      "Build Apps from a chat on the desktop",
      "Open an App as a site, public or signed-in",
      "Public Apps anyone can add, no sign-in",
      "Fix an App with your agent when a tool changes"
    ]
  },
  {
    id: "new-apps",
    label: "New apps",
    heading: ["For people who just", "want it to work."],
    intro: "New ways to use OpenWork, set up by your team. OpenWork in Slack is ready today; the rest is what we’re designing.",
    items: {
      ready: ["OpenWork in Slack", "Slack answers arrive as their own reply"],
      building: [],
      soon: ["A single, streamlined chat", "Phone app, starting with MCP Apps"]
    }
  }
];

const STATUS: Record<RoadmapStatus, { label: string; hint: string; className: string; icon: ReactNode }> = {
  ready: {
    label: "Ready",
    hint: "You can use it today",
    className: "bg-[#E7F6EE] text-[#047857]",
    icon: <Check size={12} strokeWidth={2.6} aria-hidden="true" />
  },
  building: {
    label: "Building",
    hint: "In progress",
    className: "bg-[#E8EFFD] text-[#1D4ED8]",
    icon: <LoaderCircle size={12} strokeWidth={2.4} aria-hidden="true" className="motion-safe:animate-[spin_1.8s_linear_infinite]" />
  },
  soon: {
    label: "Coming soon",
    hint: "Planned next",
    className: "text-[#5E6877] shadow-[inset_0_0_0_1px_#D3DAE4]",
    icon: <Clock3 size={12} strokeWidth={2.2} aria-hidden="true" />
  }
};

const STATUS_ORDER: RoadmapStatus[] = ["ready", "building", "soon"];

/** `label` replaces the status name where a page words the same state differently. */
export function RoadmapStatusPill({ status, label }: { status: RoadmapStatus; label?: string }) {
  const details = STATUS[status];
  return (
    <span
      data-status={status}
      className={`inline-flex h-[22px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full pl-[7px] pr-[9px] text-xs font-semibold ${details.className}`}
    >
      {details.icon}
      {label ?? details.label}
    </span>
  );
}

function Frame({ children, tall }: { children: ReactNode; tall?: boolean }) {
  return (
    <div
      className={`mt-10 flex overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_2px_4px_rgba(1,22,39,0.04),0_32px_64px_-24px_rgba(1,22,39,0.22)] md:mt-12 ${
        tall ? "h-[620px] md:h-[680px]" : ""
      }`}
    >
      {children}
    </div>
  );
}

function ComingSoonTile({ title, text, status = "soon", children }: { title: string; text: string; status?: RoadmapStatus; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col gap-6 rounded-[24px] bg-[var(--lp-tonal)] p-5 md:p-6">
      <div className="flex min-h-[340px] flex-1">{children}</div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--lp-ink)]">{title}</h3>
          <RoadmapStatusPill status={status} />
        </div>
        <p className="text-[15px] leading-[23px] text-[var(--lp-body)]">{text}</p>
      </div>
    </div>
  );
}

function Preview({ id }: { id: string }) {
  if (id === "desktop") return <Frame tall><LpDemoDesktop /></Frame>;
  if (id === "admin") return <Frame><LpDemoAiGateway /></Frame>;
  if (id === "visibility") return <Frame><RoadmapInsightsPreview /></Frame>;
  if (id === "mcp-gateway") return <Frame><LpDemoMcp /></Frame>;
  if (id === "activity") return <Frame><RoadmapActivityPreview /></Frame>;
  if (id === "web") return <Frame tall><LpDemoCloud /></Frame>;
  if (id === "workbot") return <Frame><RoadmapWorkbotPreview /></Frame>;
  if (id === "automations") return <Frame tall><AutomationsView /></Frame>;
  if (id === "workflows") return <Frame><RoadmapWorkflowPreview /></Frame>;
  if (id === "dashboards") return <Frame><RoadmapDashboardPreview /></Frame>;
  if (id === "new-apps") {
    return (
      <>
      <div className="mt-10 flex flex-col gap-6 md:mt-12 lg:flex-row">
        <ComingSoonTile
          title="A single, streamlined chat"
          text="One conversation that already knows your apps, your calendar, and what’s waiting on you. Nothing to configure."
        >
          <RoadmapStreamlinedChatPreview />
        </ComingSoonTile>
        <ComingSoonTile title="OpenWork in Slack" status="ready" text="Ask from any channel or DM and get the result back in the thread, with the same skills and connections.">
          <RoadmapSlackPreview />
        </ComingSoonTile>
      </div>
      <div className="mt-6 flex flex-col items-center gap-8 rounded-[24px] bg-[var(--lp-tonal)] p-5 md:flex-row md:gap-12 md:p-8">
        <RoadmapPhonePreview />
        <div className="flex max-w-[460px] flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--lp-ink)]">Phone app</h3>
            <RoadmapStatusPill status="soon" />
          </div>
          <p className="text-[15px] leading-[23px] text-[var(--lp-body)]">
            Starts with your MCP Apps: the quick views your team already built, like today’s meetings, open issues, and pipeline, in your pocket. Chat and approvals come next.
          </p>
        </div>
      </div>
      </>
    );
  }
  return null;
}

function previewMailto(item: string) {
  return `mailto:team@openworklabs.com?subject=${encodeURIComponent(`Preview access: ${item}`)}`;
}

function StatusColumns({ product }: { product: RoadmapProduct }) {
  return (
    <div className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
      {STATUS_ORDER.map((status) => {
        const items = product.items[status];
        return (
          <div key={status} data-column={status} className="flex flex-col">
            <div className="flex h-10 items-center justify-between border-b border-[var(--lp-ink)]">
              <RoadmapStatusPill status={status} />
              <span className="text-[13px] tabular-nums text-[var(--lp-muted)]">{items.length}</span>
            </div>
            <ul>
              {items.length === 0 ? (
                <li className="flex min-h-[46px] items-center border-b border-[var(--lp-border)] text-[14.5px] text-[#9AA5BA]">Nothing yet</li>
              ) : (
                items.map((item) => (
                  <li
                    key={item}
                    className={`flex min-h-[46px] items-center justify-between gap-3 border-b border-[var(--lp-border)] py-2 text-[14.5px] ${
                      status === "soon" ? "text-[var(--lp-body)]" : "text-[var(--lp-ink)]"
                    }`}
                  >
                    {item}
                    {product.preview?.includes(item) ? (
                      <a
                        data-preview
                        href={previewMailto(item)}
                        title="Email us for access"
                        className="inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-full bg-[#FEF3C7] pl-[7px] pr-[9px] text-xs font-semibold text-[#92400E] transition-colors hover:bg-[#FDE68A]"
                      >
                        <Mail size={12} strokeWidth={2.2} aria-hidden="true" />
                        Preview
                      </a>
                    ) : status === "ready" && product.fresh?.includes(item) ? (
                      <span data-fresh className="shrink-0 text-xs font-semibold text-[#047857]">
                        New
                      </span>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

type ShippedEntry = { date: string; name: string; detail: string; area: string };

/* Newest first. Each date is the release or rollout day in
 * packages/docs/changelog.mdx; entries older than 30 days come off the list. */
export const ROADMAP_SHIPPED: ShippedEntry[] = [
  { date: "Nov 12", name: "AI Gateway in Cursor, Claude Code, and Codex", detail: "Members create their own key and set up their tool in one step", area: "Admin" },
  { date: "Nov 12", name: "Smart Model Router", detail: "Picks a model for each prompt, set per team", area: "Admin" },
  { date: "Nov 12", name: "Organization config export and import", detail: "Copy one organization’s setup into another", area: "Admin" },
  { date: "Nov 10", name: "Roles for any person or team", detail: "Custom roles, with Super admin and Billing manager ready-made", area: "Admin" },
  { date: "Nov 10", name: "Workbot on your phone", detail: "Full-screen chat, documents, and results on iPhone", area: "Workbot" },
  { date: "Nov 10", name: "Apps as sites", detail: "Open an App in a browser, public or behind sign-in", area: "Dashboards" },
  { date: "Nov 5", name: "Mac computer use across apps", detail: "Agents work in several apps and hand your files back", area: "Desktop" },
  { date: "Nov 5", name: "Saved Workflows", detail: "Name a Workflow and find it in My Library", area: "Workflows" },
  { date: "Nov 3", name: "Website tools in the browser", detail: "Agents use a site’s own tools instead of clicking through it", area: "Desktop" },
  { date: "Nov 3", name: "Rules for what agents can do", detail: "Allow, ask first, or block computer use, scripting, and uploads", area: "Admin" },
  { date: "Nov 3", name: "Your own MCP in the Library", detail: "Members add a personal MCP server", area: "Desktop" },
  { date: "Oct 30", name: "Every-few-hours and meeting schedules", detail: "Automations run on an interval, or before and after a meeting", area: "Automations" },
  { date: "Oct 26", name: "Import from Claude", detail: "Claude chats and Claude Code sessions become OpenWork chats", area: "Desktop" },
  { date: "Oct 26", name: "Computer use on Windows", detail: "Agents use the apps on your PC", area: "Desktop" },
  { date: "Oct 26", name: "Organization prompts", detail: "One instruction, added to every member’s agent", area: "Sharing" },
  { date: "Oct 23", name: "OneDrive and SharePoint files", detail: "Open, edit, and save Word, Excel, and PowerPoint", area: "MCP Gateway" },
  { date: "Oct 22", name: "OpenCode v2 for everyone", detail: "Older installs move over in the background, with a backup", area: "Desktop" },
  { date: "Oct 13", name: "Self-hosted OpenWork Web", detail: "Run Web, Slack, and Automations on your own AWS", area: "Web" }
];

/** Desktop releases in the same 30 days, v0.18.58 to v0.18.66. */
const RELEASES_IN_WINDOW = 9;

function ShippedColumn({ entries }: { entries: ShippedEntry[] }) {
  return (
    <ol className="flex flex-1 flex-col overflow-hidden rounded-[14px] bg-white">
      {entries.map((entry, index) => {
        const firstOfDay = index === 0 || entries[index - 1].date !== entry.date;
        return (
          <li
            key={entry.name}
            data-shipped={entry.date}
            className={`flex min-h-[58px] flex-1 items-center gap-4 px-4 py-2.5 ${index === 0 ? "" : "border-t border-[var(--lp-border)]"}`}
          >
            <span className="w-[46px] shrink-0 text-xs tabular-nums text-[var(--lp-muted)]">{firstOfDay ? entry.date : ""}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13.5px] font-medium text-[var(--lp-ink)]">{entry.name}</span>
              <span className="text-xs leading-[18px] text-[var(--lp-muted)]">{entry.detail}</span>
            </span>
            <span className="hidden shrink-0 text-xs text-[var(--lp-muted)] sm:block">{entry.area}</span>
          </li>
        );
      })}
    </ol>
  );
}

function countByStatus(status: RoadmapStatus) {
  return ROADMAP_PRODUCTS.reduce((total, product) => total + product.items[status].length, 0);
}

export function RoadmapPage() {
  const half = Math.ceil(ROADMAP_SHIPPED.length / 2);

  return (
    <div data-testid="openwork-roadmap" className="text-[var(--lp-ink)]">
      <section className="pb-4 pt-12 md:pt-20">
        <p className="text-[15px] text-[var(--lp-muted)]">Roadmap, updated November 12</p>
        <h1 className="mt-5 text-[clamp(2.5rem,4vw,3.25rem)] font-medium leading-[1.08] tracking-[-0.045em]">
          <span className="block">A workspace for everyone.</span>
          <span className="block">On any platform.</span>
        </h1>
        <p className="mt-6 max-w-[640px] text-[17px] leading-[1.6] text-[var(--lp-body)] lg:text-lg">
          Teams of every size get the controls they care about. Everyone else gets AI that is set up for them, on desktop, web, and the agents they already use.
        </p>
      </section>

      <section aria-labelledby="shipped-heading" data-testid="roadmap-shipped" className="mt-10 rounded-[24px] bg-[var(--lp-tonal)] p-4 md:mt-12 md:p-6">
        <div className="flex flex-col gap-2 px-1 pb-4 sm:flex-row sm:items-end sm:justify-between md:pb-5">
          <div>
            <h2 id="shipped-heading" className="text-[22px] font-medium leading-[28px] tracking-[-0.02em]">
              Shipped in the last 30 days
            </h2>
            <p className="mt-1 text-sm text-[var(--lp-muted)]">
              {RELEASES_IN_WINDOW} desktop releases, {ROADMAP_SHIPPED.length} things you can use today.
            </p>
          </div>
          <a href="/docs/changelog" className="inline-flex items-center gap-1 text-sm font-medium text-[var(--lp-ink)] underline-offset-4 hover:underline">
            Full changelog
            <ArrowRight size={14} strokeWidth={2.2} aria-hidden="true" />
          </a>
        </div>
        <div className="flex flex-col gap-3 lg:flex-row">
          <ShippedColumn entries={ROADMAP_SHIPPED.slice(0, half)} />
          <ShippedColumn entries={ROADMAP_SHIPPED.slice(half)} />
        </div>
      </section>

      <section aria-label="Roadmap overview" className="mt-16 flex flex-col gap-6 md:mt-20">
        <div className="flex flex-wrap gap-x-7 gap-y-3">
          {STATUS_ORDER.map((status) => (
            <span key={status} className="flex items-center gap-2.5 text-[13px] text-[var(--lp-muted)]">
              <RoadmapStatusPill status={status} />
              <span>
                <span className="font-semibold tabular-nums text-[var(--lp-ink)]">{countByStatus(status)}</span> {STATUS[status].hint.toLowerCase()}
              </span>
            </span>
          ))}
        </div>
        <nav aria-label="Products" className="flex flex-wrap gap-2">
          {ROADMAP_PRODUCTS.map((product) => (
            <a
              key={product.id}
              href={`#${product.id}`}
              className="inline-flex h-8 items-center rounded-full bg-white px-3.5 text-[13px] text-[var(--lp-ink)] shadow-[inset_0_0_0_1px_var(--lp-border)] transition-colors hover:bg-[var(--lp-tonal)]"
            >
              {product.label}
            </a>
          ))}
        </nav>
      </section>

      {ROADMAP_PRODUCTS.map((product) => (
        <section key={product.id} id={product.id} aria-labelledby={`${product.id}-heading`} className="mt-24 scroll-mt-24 md:mt-28">
          <div className="text-[15px] text-[var(--lp-muted)]">{product.label}</div>
          <h2
            id={`${product.id}-heading`}
            className="mt-3 text-[36px] font-light leading-[42px] tracking-[-0.015em] md:text-[44px] md:leading-[50px]"
          >
            <span className="block">{product.heading[0]}</span>
            <span className="block">{product.heading[1]}</span>
          </h2>
          <p className="mt-6 max-w-[640px] text-[16px] leading-[25px] text-[var(--lp-body)]">{product.intro}</p>
          <Preview id={product.id} />
          <StatusColumns product={product} />
        </section>
      ))}

      <section className="mt-32 flex flex-col gap-5 border-t border-[var(--lp-border)] pb-8 pt-12 sm:flex-row sm:items-center sm:justify-between md:mt-40">
        <h2 className="text-[28px] font-light leading-[34px] tracking-[-0.015em]">What should we build next?</h2>
        <a href="/feedback?source=roadmap" className="lp-pill-primary lp-pill-sm self-start sm:self-auto">
          Share feedback
        </a>
      </section>
    </div>
  );
}
