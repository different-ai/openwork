import { HardDrive, KeyRound, ShieldCheck, type LucideIcon } from "lucide-react";

export const statusPageRequestHref =
  "mailto:team@openworklabs.com?subject=OpenWork%20status%20page%20request";

type TrustLine = {
  label: string;
  value: string;
};

export type TrustSection = {
  eyebrow: string;
  title: string;
  description: string;
  lines: TrustLine[];
  icon: LucideIcon;
  tileClassName: string;
};

export const trustSections: TrustSection[] = [
  {
    eyebrow: "Control",
    title: "Keep infrastructure and data decisions in your hands.",
    description:
      "OpenWork is built so enterprise teams can keep trust-critical decisions tied to their own environment and provider choices.",
    lines: [
      {
        label: "Self-hosting",
        value: "Run OpenWork in your own environment when infrastructure ownership matters."
      },
      {
        label: "Data residency",
        value: "When you self-host, residency follows your environment rather than a hidden managed default."
      }
    ],
    icon: KeyRound,
    tileClassName: "bg-violet-50 text-violet-700"
  },
  {
    eyebrow: "Boundaries",
    title: "The runtime model is explicit enough to review.",
    description:
      "OpenWork makes local, remote, and provider boundaries understandable instead of burying them under a hosted black box.",
    lines: [
      {
        label: "Local-first",
        value: "Desktop paths start close to the user, with remote behavior chosen explicitly."
      },
      {
        label: "BYOK",
        value: "Bring your own keys and work with the provider stack your team already approves."
      }
    ],
    icon: HardDrive,
    tileClassName: "bg-emerald-50 text-emerald-700"
  },
  {
    eyebrow: "Follow-through",
    title: "Operational trust stays specific.",
    description:
      "We surface what is available in review without padding the page with incomplete uptime or compliance claims.",
    lines: [
      {
        label: "Review materials",
        value: "Status page access and subprocessor disclosure are available during enterprise review."
      },
      {
        label: "Incident path",
        value: "Enterprise conversations include the path for security and operational follow-up."
      }
    ],
    icon: ShieldCheck,
    tileClassName: "bg-amber-50 text-amber-700"
  }
];
