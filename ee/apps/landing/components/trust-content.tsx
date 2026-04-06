import {
  Building2,
  Clock,
  HardDrive,
  KeyRound,
  Shield,
  Users,
  type LucideIcon
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Key facts — the at-a-glance grid at the top of the page           */
/* ------------------------------------------------------------------ */

export type KeyFact = {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
};

export const keyFacts: KeyFact[] = [
  {
    label: "Deployment",
    value: "Self-hosted",
    detail: "Desktop app on your servers",
    icon: Building2
  },
  {
    label: "Data storage",
    value: "Local-only",
    detail: "Nothing leaves your machine",
    icon: HardDrive
  },
  {
    label: "LLM keys",
    value: "Bring your own",
    detail: "Direct to your provider",
    icon: KeyRound
  },
  {
    label: "Telemetry",
    value: "None",
    detail: "Opt-in feedback only",
    icon: Shield
  },
  {
    label: "Incident SLA",
    value: "72hr notify",
    detail: "3-day ack · 7-day triage",
    icon: Clock
  },
  {
    label: "Subprocessors",
    value: "5 named vendors",
    detail: "Cloud & website only",
    icon: Users
  }
];

/* ------------------------------------------------------------------ */
/*  Data handling table                                               */
/* ------------------------------------------------------------------ */

export type DataHandlingRow = {
  dataType: string;
  selfHosted: string;
  cloud: string;
};

export const dataHandlingRows: DataHandlingRow[] = [
  {
    dataType: "Source code",
    selfHosted: "Local only — never leaves your machine",
    cloud: "Not stored by OpenWork; accessed at runtime via your LLM provider"
  },
  {
    dataType: "LLM API keys",
    selfHosted: "Local keychain or environment variables",
    cloud: "Stored by your LLM provider, never by OpenWork"
  },
  {
    dataType: "Prompts & responses",
    selfHosted: "Local only",
    cloud: "Passed to your configured LLM provider; not logged by OpenWork"
  },
  {
    dataType: "Usage telemetry",
    selfHosted: "None",
    cloud: "Anonymous, via PostHog; can be disabled"
  },
  {
    dataType: "Authentication",
    selfHosted: "Your SSO / SAML provider",
    cloud: "Google or GitHub OAuth"
  }
];

/* ------------------------------------------------------------------ */
/*  Subprocessors                                                     */
/* ------------------------------------------------------------------ */

export type Subprocessor = {
  name: string;
  purpose: string;
  category: string;
  location: string;
  href: string;
};

export const subprocessors: Subprocessor[] = [
  {
    name: "PostHog",
    purpose: "Anonymous website analytics and product telemetry",
    category: "Analytics",
    location: "US / EU",
    href: "https://posthog.com"
  },
  {
    name: "Polar",
    purpose: "Subscription billing and payment processing",
    category: "Payments",
    location: "US",
    href: "https://polar.sh"
  },
  {
    name: "Google",
    purpose: "OAuth sign-in and authentication services",
    category: "Authentication",
    location: "US",
    href: "https://google.com"
  },
  {
    name: "GitHub",
    purpose: "OAuth sign-in and source code hosting",
    category: "Authentication",
    location: "US",
    href: "https://github.com"
  },
  {
    name: "Daytona",
    purpose: "Virtual sandbox infrastructure for the Cloud Service",
    category: "Infrastructure",
    location: "EU",
    href: "https://daytona.io"
  }
];

/* ------------------------------------------------------------------ */
/*  Section anchors (for the "On this page" nav)                      */
/* ------------------------------------------------------------------ */

export const sectionAnchors = [
  { id: "deployment", label: "Deployment Model" },
  { id: "data-handling", label: "Data Handling" },
  { id: "data-residency", label: "Data Residency" },
  { id: "subprocessors", label: "Subprocessors" },
  { id: "incident-response", label: "Incident Response" },
  { id: "compliance", label: "Compliance" },
  { id: "contact", label: "Security Contact" }
];

/* ------------------------------------------------------------------ */
/*  Security contact                                                  */
/* ------------------------------------------------------------------ */

export const securityContact = {
  name: "Omar McAdam",
  email: "team+security@openworklabs.com"
};
