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
  "mailto:team@openworklabs.com?subject=Status%20page%20access%20request&body=Hi%20OpenWork%20team%2C%0A%0AWe%27re%20evaluating%20OpenWork%20and%20would%20like%20access%20to%20the%20status%20page%20for%20operational%20review.%0A%0ACompany%3A%20%5Byour%20company%5D%0AUse%20case%3A%20%5Bbrief%20description%5D%0A%0AThanks";

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

export type Subprocessor = {
  name: string;
  purpose: string;
  category: string;
  location: string;
  brandColor: string;
  textColor: string;
  initial: string;
  href: string;
};

export const subprocessors: Subprocessor[] = [
  {
    name: "PostHog",
    purpose: "Anonymous website analytics and product telemetry",
    category: "Analytics",
    location: "US / EU",
    brandColor: "#FFF0EB",
    textColor: "#C93C00",
    initial: "PH",
    href: "https://posthog.com"
  },
  {
    name: "Polar",
    purpose: "Subscription billing and payment processing",
    category: "Payments",
    location: "US",
    brandColor: "#F3EEFF",
    textColor: "#6D28D9",
    initial: "PO",
    href: "https://polar.sh"
  },
  {
    name: "Google",
    purpose: "OAuth sign-in and authentication services",
    category: "Authentication",
    location: "US",
    brandColor: "#EAF1FB",
    textColor: "#1A56C4",
    initial: "G",
    href: "https://google.com"
  },
  {
    name: "GitHub",
    purpose: "OAuth sign-in and source code hosting",
    category: "Authentication",
    location: "US",
    brandColor: "#F0F0F0",
    textColor: "#24292E",
    initial: "GH",
    href: "https://github.com"
  },
  {
    name: "Daytona",
    purpose: "Virtual sandbox infrastructure for the Cloud Service",
    category: "Infrastructure",
    location: "EU",
    brandColor: "#E0F7FA",
    textColor: "#0277BD",
    initial: "D",
    href: "https://daytona.io"
  }
];

export const trustTopics: TrustTopic[] = [
  {
    slug: "self-hosted-deployment",
    label: "Self-hosting",
    title: "Your infra, your rules.",
    panelIntro:
      "Enterprise governance, regional compliance, and internal security reviews get simpler when you own the stack (and the data!). Self-host with confidence, not as a fallback.",
    bullets: [
      "OpenWork supports desktop-hosted, CLI-hosted, and hosted cloud server paths.",
      "We help enterpises avoid lock-in with a single LLM provider and retain their data ownership.",
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
    title: "Local-first by design.",
    panelIntro:
      "Most AI tooling defaults to cloud and asks you to opt out. We are local-first, and cloud connections are explicit choices your team makes, not hidden defaults.",
    bullets: [
      "The desktop-hosted app/server path is a first-class way to run OpenWork.",
      "Hosted and self-hosted modes share the same user-level connect flow instead of separate products.",
      "OpenWork stays open, local-first, and standards-based in the product vision.",
      "Runtime boundaries stay legible and transparent for enterprise review."
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
    label: "BYOK",
    title: "Bring your own keys.",
    panelIntro:
      "Keep your existing model provider agreements intact. When you connect directly with your own credentials, your usage stays between you and your provider.",
    bullets: [
      "We do not collect or analyze usage or performance analytics. No telemetry without consent.",
      "Individual Teams can keep provider choice aligned with internal approvals and procurement.",
      "Third-party model providers connected with your own credentials are governed by their own terms.",
      "We also support custom proxy gateways such as LiteLLM and Cloudflare AI Gateway. "
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
    label: "Data residency",
    title: "The Data stays where your company or customers are.",
    panelIntro:
      "Data regulations shouldn't restrict innovation. Self-hosted environments give your team full authority over region, network boundary, and egress policy without negotiating with a control plane.",
    bullets: [
      "We let you choose your own data Residency instead of imposing ours.",
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
    title: "We'll notify of any major security incident withtin 72 hours.",
    panelIntro:
      "We commit to a 3-day acknowledgment and notification of any major security incident. By default, we also commit to a 7-day triage and resolution for high priority issues.",
    bullets: [
      "Security issues can be reported privately or via a github issue if you're a security researcher.",
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
    title: "Real operational data, on request.",
    panelIntro:
      "We uphold SLAs, uptime and other reliability parameters via measurable metrics, not a marketing copy.",
    bullets: [
      "Status information is available by request.",
      "Operational review can happen without padded uptime claims.",
      "Request access to live status data during procurement so you can evaluate our reliability.",
      "Feel free to request access to our status page by clicking at the button below:"
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
    title: "No hidden third parties.",
    panelIntro:
      "Every vendor that touches data in the OpenWork cloud path is named in the privacy policy. Procurement teams can evaluate each subprocessor's data handling before signing, not after.",
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
