import { Check, Clock3, LoaderCircle } from "lucide-react";
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
  RoadmapWorkflowPreview
} from "./roadmap-previews";

export type RoadmapStatus = "ready" | "building" | "soon";

export type RoadmapProduct = {
  id: string;
  label: string;
  heading: [string, string];
  intro: string;
  items: Record<RoadmapStatus, string[]>;
};

/* One entry per product. The status is the column an item sits in, so a
 * reader never has to decode a badge. Keep this in step with
 * packages/docs/roadmap.mdx. */
export const ROADMAP_PRODUCTS: RoadmapProduct[] = [
  {
    id: "desktop",
    label: "Desktop",
    heading: ["The desktop app", "is home."],
    intro: "Work on your own files with any model. Skills, connections, and a built-in browser, on macOS, Windows, and Linux.",
    items: {
      ready: ["macOS, Windows, and Linux", "Skills, plugins, and connections", "Built-in browser", "Files, artifacts, and any model"],
      building: ["MCP Apps", "Live artifacts", "Sandboxed workspaces"],
      soon: ["Pick up work on any device"]
    }
  },
  {
    id: "admin",
    label: "Admin",
    heading: ["You set the rules.", "Every surface follows."],
    intro: "OpenWork Cloud is where admins manage models, spend, policies, and access for every team.",
    items: {
      ready: ["AI Gateway for every provider", "Usage, spend, and hard limits by team", "Desktop policies by team or member", "SSO, teams, and roles"],
      building: ["Fully managed desktop"],
      soon: ["Audit logs", "Admin roles for security and IT", "Use the AI Gateway from Codex and Cursor"]
    }
  },
  {
    id: "visibility",
    label: "Visibility",
    heading: ["See what works,", "and what doesn’t."],
    intro: "Know which skills, connections, and teams are getting real work done, and which aren’t, so you can show the return on your AI spend.",
    items: {
      ready: ["Usage and adoption by person", "Spend by team and model"],
      building: ["Organization activity: who shared and changed what"],
      soon: ["What’s used, and what isn’t", "Failures by skill and connection", "Results and spend by team"]
    }
  },
  {
    id: "mcp-gateway",
    label: "MCP Gateway",
    heading: ["Set up your MCPs once.", "Your whole team has them."],
    intro: "One MCP URL brings your team’s skills, plugins, and connections into Claude Code, Codex, Cursor, and any MCP client.",
    items: {
      ready: ["One MCP URL for your whole team", "Claude Code, Codex, Cursor, and ChatGPT", "Skills, plugins, and connections by team", "Shared or per-person sign-in"],
      building: ["Sync plugins from Git", "One app identity enterprises allowlist once"],
      soon: ["Stricter sign-in checks for enterprise gateways"]
    }
  },
  {
    id: "activity",
    label: "Sharing and activity",
    heading: ["Your team’s best work,", "in everyone’s hands."],
    intro:
      "Make sure your organization uses its latest advances to push further. When someone shares a skill, publishes a new version, or connects an app, the people who can use it hear about it and can try it right away.",
    items: {
      ready: ["Share skills and plugins with a team", "Company marketplaces", "See who can use each plugin"],
      building: ["Activity: what’s new for you", "Try a new skill from its update", "Compare a new version with the last one"],
      soon: []
    }
  },
  {
    id: "web",
    label: "Web",
    heading: ["The same workspace,", "in your browser."],
    intro: "Everything from the desktop app, running in the cloud. Nothing to install, and work keeps going when you close the tab.",
    items: {
      ready: ["The full workspace in your browser", "Your team’s skills and connections", "Remote workspaces from the desktop"],
      building: ["Instant start", "Always-on cloud workspace", "Background tasks"],
      soon: ["Session sharing"]
    }
  },
  {
    id: "automations",
    label: "Automations",
    heading: ["Set it once.", "It runs on its own."],
    intro: "Schedule any task on the web or the desktop, with the same skills and connections as a normal chat.",
    items: {
      ready: ["Schedules on web and desktop", "Daily and weekly runs", "Missed and interrupted runs are shown"],
      building: ["Saved workflows from a chat that worked"],
      soon: ["Custom schedules", "Team plan, no OpenWork Web needed", "Fine-grained automation control", "Approvals in the middle of a run"]
    }
  },
  {
    id: "workflows",
    label: "Workflows",
    heading: ["Every step,", "out in the open."],
    intro: "Save a task that worked as a workflow. Each step, decision, and result is laid out like a flow, without building it by hand.",
    items: {
      ready: ["Live workflows across your connected apps", "A step-by-step flow for every workflow", "Run history with each step’s result"],
      building: ["Share workflows with your team"],
      soon: ["Live edit"]
    }
  },
  {
    id: "dashboards",
    label: "Dashboards",
    heading: ["What matters today,", "at a glance."],
    intro: "Your people build their own quick views, like today’s meetings or open issues, from the apps they already use. Built on the MCP Apps standard.",
    items: {
      ready: ["Quick-glance views your people create", "Works with MCP Apps"],
      building: ["Build dashboards from the desktop app"],
      soon: []
    }
  },
  {
    id: "new-apps",
    label: "New apps",
    heading: ["For people who just", "want it to work."],
    intro: "New ways to use OpenWork, set up by your team. None is available yet. This is what we’re designing.",
    items: {
      ready: [],
      building: [],
      soon: ["A single, streamlined chat", "OpenWork in Slack", "Phone app, starting with MCP Apps"]
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
    icon: <LoaderCircle size={12} strokeWidth={2.4} aria-hidden="true" />
  },
  soon: {
    label: "Coming soon",
    hint: "Planned next",
    className: "text-[#5E6877] shadow-[inset_0_0_0_1px_#D3DAE4]",
    icon: <Clock3 size={12} strokeWidth={2.2} aria-hidden="true" />
  }
};

const STATUS_ORDER: RoadmapStatus[] = ["ready", "building", "soon"];

export function RoadmapStatusPill({ status }: { status: RoadmapStatus }) {
  const details = STATUS[status];
  return (
    <span
      data-status={status}
      className={`inline-flex h-[22px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full pl-[7px] pr-[9px] text-xs font-semibold ${details.className}`}
    >
      {details.icon}
      {details.label}
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

function ComingSoonTile({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col gap-6 rounded-[24px] bg-[var(--lp-tonal)] p-5 md:p-6">
      <div className="flex min-h-[340px] flex-1">{children}</div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--lp-ink)]">{title}</h3>
          <RoadmapStatusPill status="soon" />
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
        <ComingSoonTile title="OpenWork in Slack" text="Ask from any channel or DM and get the result back in the thread, with the same skills and connections.">
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

function StatusColumns({ product }: { product: RoadmapProduct }) {
  return (
    <div className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
      {STATUS_ORDER.map((status) => {
        const items = product.items[status];
        return (
          <div key={status} data-column={status} className="flex flex-col">
            <div className="flex h-10 items-center border-b border-[var(--lp-ink)]">
              <RoadmapStatusPill status={status} />
            </div>
            <ul>
              {items.length === 0 ? (
                <li className="flex min-h-[46px] items-center border-b border-[var(--lp-border)] text-[14.5px] text-[#9AA5BA]">Nothing yet</li>
              ) : (
                items.map((item) => (
                  <li
                    key={item}
                    className={`flex min-h-[46px] items-center border-b border-[var(--lp-border)] py-2 text-[14.5px] ${
                      status === "soon" ? "text-[var(--lp-body)]" : "text-[var(--lp-ink)]"
                    }`}
                  >
                    {item}
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

const SHIPPED = [
  { name: "AI Gateway", detail: "Spend, limits, and usage by team" },
  { name: "Desktop policies", detail: "By org, team, or member" },
  { name: "OpenWork Web", detail: "The full workspace in your browser" },
  { name: "Automations", detail: "On web and desktop" }
];

export function RoadmapPage() {
  return (
    <div data-testid="openwork-roadmap" className="text-[var(--lp-ink)]">
      <section className="flex flex-col gap-12 pb-4 pt-12 md:pt-20 lg:flex-row lg:items-end lg:gap-16">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] text-[var(--lp-muted)]">Roadmap, updated September 28</p>
          <h1 className="mt-5 text-[clamp(2.5rem,4vw,3.25rem)] font-medium leading-[1.08] tracking-[-0.045em]">
            <span className="block">A workspace for everyone.</span>
            <span className="block">On any platform.</span>
          </h1>
          <p className="mt-6 max-w-[640px] text-[17px] leading-[1.6] text-[var(--lp-body)] lg:text-lg">
            Teams of every size get the controls they care about. Everyone else gets AI that is set up for them, on desktop, web, and the agents they already use.
          </p>
          <div className="mt-8 flex flex-wrap gap-x-7 gap-y-3">
            {STATUS_ORDER.map((status) => (
              <span key={status} className="flex items-center gap-2.5 text-[13px] text-[var(--lp-muted)]">
                <RoadmapStatusPill status={status} />
                {STATUS[status].hint}
              </span>
            ))}
          </div>
        </div>
        <div className="flex w-full flex-col gap-2 rounded-[24px] bg-[var(--lp-tonal)] p-5 lg:w-[400px] lg:shrink-0">
          <span className="px-1 pb-1.5 text-sm text-[var(--lp-muted)]">Shipped since August</span>
          {SHIPPED.map((item) => (
            <div key={item.name} className="flex min-h-[52px] items-center gap-3 rounded-[10px] bg-white px-3.5">
              <Check size={13} strokeWidth={2.6} className="shrink-0 text-[#047857]" aria-hidden="true" />
              <span className="flex flex-col">
                <span className="text-[13.5px] font-medium text-[var(--lp-ink)]">{item.name}</span>
                <span className="text-xs text-[var(--lp-muted)]">{item.detail}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {ROADMAP_PRODUCTS.map((product) => (
        <section key={product.id} id={product.id} aria-labelledby={`${product.id}-heading`} className="mt-28 scroll-mt-24 md:mt-36">
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
