import {
  Building2,
  Database,
  HardDrive,
  KeyRound,
  LifeBuoy,
  ShieldCheck,
  type LucideIcon
} from "lucide-react";

export const statusPageRequestHref =
  "mailto:team@openworklabs.com?subject=OpenWork%20status%20page%20request";

type TrustLink = {
  label: string;
  href: string;
  external?: boolean;
};

export type TrustTopic = {
  slug: string;
  label: string;
  title: string;
  panelIntro: string;
  bullets: string[];
  icon: LucideIcon;
  toneClassName: string;
  links: TrustLink[];
};

export const trustTopics: TrustTopic[] = [
  {
    slug: "self-hosted-deployment",
    label: "Self-hosted deployment",
    title: "Run OpenWork in infrastructure your team controls.",
    panelIntro:
      "Run OpenWork in your own environment when infrastructure ownership, internal governance, or customer-managed residency matters.",
    bullets: [
      "OpenWork supports desktop-hosted, CLI-hosted, and hosted cloud server paths.",
      "Self-hosted paths remain valid and are not treated as a secondary deployment mode.",
      "Your team keeps infrastructure ownership when you deploy in your own environment.",
      "Enterprise review does not require adopting a hosted-only control plane."
    ],
    icon: Building2,
    toneClassName: "bg-blue-50 text-blue-700",
    links: [
      { label: "Enterprise", href: "/enterprise" },
      {
        label: "Infrastructure",
        href: "https://github.com/different-ai/openwork/blob/dev/INFRASTRUCTURE.md",
        external: true
      }
    ]
  },
  {
    slug: "local-first-workflows",
    label: "Local-first workflows",
    title: "Keep workflow boundaries understandable from the start.",
    panelIntro:
      "OpenWork is designed around a local-first, cloud-ready model so teams can review where work starts and how remote behavior is introduced.",
    bullets: [
      "The desktop-hosted app/server path is a first-class way to run OpenWork.",
      "Hosted and self-hosted modes share the same user-level connect flow instead of separate products.",
      "OpenWork stays open, local-first, and standards-based in the product vision.",
      "Runtime boundaries stay legible enough for enterprise review."
    ],
    icon: HardDrive,
    toneClassName: "bg-emerald-50 text-emerald-700",
    links: [
      {
        label: "Vision",
        href: "https://github.com/different-ai/openwork/blob/dev/VISION.md",
        external: true
      },
      {
        label: "Architecture",
        href: "https://github.com/different-ai/openwork/blob/dev/ARCHITECTURE.md",
        external: true
      }
    ]
  },
  {
    slug: "provider-and-key-control",
    label: "Provider and key control",
    title: "Use your own providers and your own keys.",
    panelIntro:
      "Use your own keys and existing provider relationships instead of adopting a closed default stack.",
    bullets: [
      "OpenWork supports bring-your-own-key model access.",
      "Teams can keep provider choice aligned with internal approvals and procurement.",
      "Third-party model providers connected with your own credentials are governed by their own terms.",
      "OpenWork does not present your chosen model providers as OpenWork subprocessors when you connect directly."
    ],
    icon: KeyRound,
    toneClassName: "bg-violet-50 text-violet-700",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" }
    ]
  },
  {
    slug: "data-residency-controls",
    label: "Data residency controls",
    title: "Residency follows how and where you deploy OpenWork.",
    panelIntro:
      "Data residency follows your deployment model. In self-hosted environments, infrastructure location stays under customer control.",
    bullets: [
      "Residency decisions follow where your team runs OpenWork.",
      "Self-hosted environments keep infrastructure location under customer control.",
      "OpenWork avoids forcing a cloud-only lock-in model for teams that need residency control.",
      "Provider choice and deployment choice stay separate for cleaner review."
    ],
    icon: Database,
    toneClassName: "bg-cyan-50 text-cyan-700",
    links: [
      {
        label: "Infrastructure",
        href: "https://github.com/different-ai/openwork/blob/dev/INFRASTRUCTURE.md",
        external: true
      },
      { label: "Privacy", href: "/privacy" }
    ]
  },
  {
    slug: "incident-response",
    label: "Incident response",
    title: "Security reports have a documented private path.",
    panelIntro:
      "OpenWork provides a documented path for reporting vulnerabilities and sets response expectations in the public security policy.",
    bullets: [
      "Security issues should be reported privately rather than through public GitHub issues.",
      "The public security policy asks reporters to include impact and reproduction details.",
      "OpenWork commits to acknowledge receipt within 3 business days.",
      "OpenWork commits to share an initial triage status within 7 business days."
    ],
    icon: ShieldCheck,
    toneClassName: "bg-amber-50 text-amber-700",
    links: [
      {
        label: "Security policy",
        href: "https://github.com/different-ai/openwork/blob/dev/SECURITY.md",
        external: true
      },
      {
        label: "Support",
        href: "https://github.com/different-ai/openwork/blob/dev/SUPPORT.md",
        external: true
      }
    ]
  },
  {
    slug: "status-page-access",
    label: "Status page access",
    title: "Status information is available during enterprise review.",
    panelIntro:
      "Status page access is available on request for enterprise teams that want more operational transparency during review.",
    bullets: [
      "Status information is available by request.",
      "The trust page does not imply a formal uptime SLA.",
      "Operational review can happen without padded uptime claims.",
      "The same team inbox handles status page requests from enterprise prospects."
    ],
    icon: LifeBuoy,
    toneClassName: "bg-rose-50 text-rose-700",
    links: [
      { label: "Request status page", href: statusPageRequestHref, external: true },
      { label: "Enterprise", href: "/enterprise" }
    ]
  },
  {
    slug: "subprocessors",
    label: "Subprocessors",
    title: "Current subprocessors are already listed publicly.",
    panelIntro:
      "OpenWork already publishes its current subprocessors in the privacy policy for procurement and security review.",
    bullets: [
      "PostHog handles anonymous website analytics.",
      "Polar handles subscription billing and payment processing.",
      "Google and GitHub provide OAuth sign-in services.",
      "Daytona provides virtual sandbox infrastructure for the Cloud Service."
    ],
    icon: ShieldCheck,
    toneClassName: "bg-slate-100 text-slate-700",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" }
    ]
  }
];

export const defaultTrustTopicSlug = trustTopics[0].slug;

export function getTrustTopic(slug: string) {
  return trustTopics.find((topic) => topic.slug === slug);
}
