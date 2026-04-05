import {
  Activity,
  ArrowUpRight,
  Database,
  HardDrive,
  KeyRound,
  Server,
  ShieldCheck,
  type LucideIcon
} from "lucide-react";

export const statusPageRequestHref =
  "mailto:team@openworklabs.com?subject=OpenWork%20status%20page%20request";

type Placeholder = {
  title: string;
  body: string;
};

export type TrustSection = {
  slug: string;
  eyebrow: string;
  overviewTitle: string;
  overviewDescription: string;
  title: string;
  intro: string;
  bullets: string[];
  icon: LucideIcon;
  accentClassName: string;
  tileClassName: string;
  actionLabel?: string;
  actionHref?: string;
  placeholder?: Placeholder;
};

export const trustSections: TrustSection[] = [
  {
    slug: "deployment",
    eyebrow: "Deployment",
    overviewTitle: "Self-hosted deployment",
    overviewDescription:
      "Self-hosting keeps infrastructure ownership, network boundaries, and runtime placement in your hands.",
    title: "Self-hosted deployment",
    intro:
      "This page is meant to answer the follow-up trust question after the enterprise overview: what changes when your team wants infrastructure control. For OpenWork, self-hosting is a real product path, not a side note.",
    bullets: [
      "Desktop-hosted paths can keep OpenWork server surfaces close to the user.",
      "CLI-hosted server mode lets trusted machines provide the same OpenWork control/API layer.",
      "Hosted OpenWork Cloud paths keep the same remote-connect mental model instead of introducing a separate product.",
      "Self-hosted and hosted paths are meant to preserve the same user-level flow: add a worker, then connect remote."
    ],
    icon: Server,
    accentClassName:
      "border-blue-100 bg-blue-50 text-blue-700",
    tileClassName: "bg-slate-100 text-[#011627] shadow-inner"
  },
  {
    slug: "local-first",
    eyebrow: "Local-first",
    overviewTitle: "Local-first architecture",
    overviewDescription:
      "Desktop paths start close to the user, with remote behavior chosen explicitly rather than assumed.",
    title: "Local-first architecture",
    intro:
      "OpenWork is intentionally local-first. The product is built so teams can start from the desktop, keep sensitive work near the user, and choose remote behavior explicitly instead of inheriting it by default.",
    bullets: [
      "Local-first is a product principle, not just a hosting option.",
      "Desktop mode keeps OpenCode on loopback by default while OpenWork serves as the user-facing control surface.",
      "Remote sharing is an explicit opt-in rather than the default runtime shape.",
      "The same runtime model extends to hosted workers when teams actually want remote execution."
    ],
    icon: HardDrive,
    accentClassName:
      "border-emerald-100 bg-emerald-50 text-emerald-700",
    tileClassName: "bg-emerald-50 text-emerald-700"
  },
  {
    slug: "byok",
    eyebrow: "Provider control",
    overviewTitle: "Model + key control",
    overviewDescription:
      "Use your own keys and provider stack instead of accepting a locked hosted default.",
    title: "Bring your own keys",
    intro:
      "OpenWork is designed around provider choice. Teams can connect the models and gateways they already trust instead of adopting a locked hosted stack just to get the workflow layer.",
    bullets: [
      "OpenWork supports bring-your-own-key setups alongside existing provider and gateway choices.",
      "Teams can switch between models, local runtimes, and hosted providers based on the task.",
      "Provider control is part of the product identity, not an enterprise-only exception.",
      "This keeps procurement and security review focused on your chosen stack, not a forced default."
    ],
    icon: KeyRound,
    accentClassName:
      "border-violet-100 bg-violet-50 text-violet-700",
    tileClassName: "bg-violet-50 text-violet-700"
  },
  {
    slug: "data-residency",
    eyebrow: "Data handling",
    overviewTitle: "Data residency controls",
    overviewDescription:
      "When you self-host, residency follows your environment instead of a hidden managed default.",
    title: "Data residency controls",
    intro:
      "OpenWork does not try to hide the relationship between hosting model and data location. When you self-host, residency follows the environment you control rather than a black-box hosted default.",
    bullets: [
      "Self-hosted deployment keeps infrastructure ownership with your team.",
      "Customer-controlled environments make residency decisions easier to align with internal requirements.",
      "Deployment flexibility helps teams decide when work should stay local, self-hosted, or remote.",
      "OpenWork aims to keep runtime boundaries understandable enough for security review."
    ],
    icon: Database,
    accentClassName:
      "border-sky-100 bg-sky-50 text-sky-700",
    tileClassName: "bg-sky-50 text-sky-700",
    placeholder: {
      title: "Placeholder for human review",
      body:
        "Lorem ipsum placeholder for the exact storage, region, and retention wording you want to publish. Intention: replace this with the final procurement-safe data residency language once the team decides how specific the public page should be."
    }
  },
  {
    slug: "incident-response",
    eyebrow: "Operations",
    overviewTitle: "Incident response commitment",
    overviewDescription:
      "You should know how to reach us, how follow-up works, and where public copy still needs final policy detail.",
    title: "Incident response commitment",
    intro:
      "OpenWork can give enterprise teams a defined path for reporting issues and coordinating follow-up. The public page should stay factual here until the exact response process and publication level are finalized.",
    bullets: [
      "Enterprise customers should have a clear path to raise security or operational issues.",
      "OpenWork can coordinate updates and follow-up during active incidents.",
      "The trust page should describe the existence of the process without inventing timelines that do not exist yet.",
      "A stronger public section can be added once response windows and ownership are finalized."
    ],
    icon: ShieldCheck,
    accentClassName:
      "border-amber-100 bg-amber-50 text-amber-700",
    tileClassName: "bg-amber-50 text-amber-700",
    placeholder: {
      title: "Placeholder for human review",
      body:
        "Lorem ipsum placeholder for the exact incident intake mailbox, severity definitions, and update expectations. Intention: replace this with the concrete incident response workflow once the team decides what can be published on the landing site."
    }
  },
  {
    slug: "status-page",
    eyebrow: "Availability",
    overviewTitle: "Status page access",
    overviewDescription:
      "Status page access is available on request during enterprise review.",
    title: "Status page access",
    intro:
      "OpenWork should talk about the status page carefully: available on request, useful in enterprise review, and not presented as a public SLA or uptime promise that does not yet exist.",
    bullets: [
      "Status page access can be provided as part of enterprise evaluation and rollout conversations.",
      "This page should not imply that a public SLA already exists.",
      "The right call to action here is a request path, not a generic uptime claim.",
      "Any future public uptime language should be added only after the underlying process is finalized."
    ],
    icon: Activity,
    accentClassName:
      "border-rose-100 bg-rose-50 text-rose-700",
    tileClassName: "bg-rose-50 text-rose-700",
    actionLabel: "Request status page",
    actionHref: statusPageRequestHref,
    placeholder: {
      title: "Placeholder for human review",
      body:
        "Lorem ipsum placeholder for the exact request workflow, owner, and access expectations. Intention: replace this with the real process once the team agrees how status page access should be requested and granted."
    }
  },
  {
    slug: "subprocessors",
    eyebrow: "Vendors",
    overviewTitle: "Subprocessors",
    overviewDescription:
      "Review the managed-cloud vendor inventory and how self-hosting changes the picture.",
    title: "Subprocessors",
    intro:
      "Subprocessor disclosure matters most for managed paths. OpenWork should be explicit that self-hosting changes the vendor picture, while managed cloud paths can still have a publishable inventory for review.",
    bullets: [
      "Managed OpenWork paths can have a named subprocessor inventory for enterprise review.",
      "Self-hosted deployments can reduce reliance on OpenWork-managed vendors because infrastructure sits in your environment.",
      "The trust page should distinguish clearly between customer-controlled hosting and OpenWork-managed services.",
      "This section is a good place for the final vendor table once the public list is approved."
    ],
    icon: ArrowUpRight,
    accentClassName:
      "border-slate-200 bg-slate-50 text-slate-700",
    tileClassName: "bg-slate-100 text-slate-700",
    placeholder: {
      title: "Placeholder for human review",
      body:
        "Lorem ipsum placeholder for the initial managed-cloud subprocessor inventory. Intention: replace this with the actual vendor table and scopes once the list is approved for publication."
    }
  }
];

export function getTrustSection(slug: string) {
  return trustSections.find((section) => section.slug === slug);
}
