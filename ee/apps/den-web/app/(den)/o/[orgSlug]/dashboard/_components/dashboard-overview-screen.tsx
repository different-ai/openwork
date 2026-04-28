"use client";

import Link from "next/link";
import {
  Bot,
  CreditCard,
  Cpu,
  KeyRound,
  Monitor,
  Users,
} from "lucide-react";
import {
  getBackgroundAgentsRoute,
  getApiKeysRoute,
  getBillingRoute,
  getCustomLlmProvidersRoute,
  getOrgAccessFlags,
  getMembersRoute,
} from "../../../../_lib/den-org";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

function getGreeting(name: string | null | undefined) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = name?.trim().split(/\s+/)[0] ?? "there";
  return `${greeting}, ${firstName}`;
}

export function DashboardOverviewScreen() {
  const { orgSlug, activeOrg, orgContext } = useOrgDashboard();
  const { user } = useDenFlow();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
  );

  const quickActions = [
    {
      label: "Members",
      icon: Users,
      href: getMembersRoute(orgSlug),
      tint: "bg-cyan-50 text-cyan-600 group-hover:bg-cyan-100",
    },
    ...(access.canManageApiKeys
      ? [{
          label: "API Keys",
          icon: KeyRound,
          href: getApiKeysRoute(orgSlug),
          tint: "bg-emerald-50 text-emerald-600 group-hover:bg-emerald-100",
        }]
      : []),
    {
      label: "Shared Workspace",
      icon: Bot,
      href: getBackgroundAgentsRoute(orgSlug),
      tint: "bg-orange-50 text-orange-500 group-hover:bg-orange-100",
    },
    {
      label: "LLM Providers",
      icon: Cpu,
      href: getCustomLlmProvidersRoute(orgSlug),
      tint: "bg-lime-50 text-lime-600 group-hover:bg-lime-100",
    },
    {
      label: "Billing",
      icon: CreditCard,
      href: getBillingRoute(orgSlug),
      tint: "bg-gray-100 text-gray-600 group-hover:bg-gray-200",
    },
    {
      label: "Desktop app",
      icon: Monitor,
      href: "https://openworklabs.com/download",
      external: true,
      tint: "bg-fuchsia-50 text-fuchsia-600 group-hover:bg-fuchsia-100",
    },
  ];

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-8 md:px-8">
      <p className="mb-1 text-[12px] text-gray-400">
        {activeOrg?.name ?? "OpenWork Cloud"}
      </p>
      <h1 className="mb-8 text-[26px] tracking-[-0.5px] text-gray-900">
        {getGreeting(user?.name)}
      </h1>

      <div className="mb-10 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {quickActions.map((action) => {
          const content = (
            <>
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${action.tint}`}
              >
                <action.icon className="h-5 w-5" strokeWidth={1.8} />
              </div>
              <span className="text-center text-[12px] leading-tight text-gray-700">
                {action.label}
              </span>
            </>
          );

          const className =
            "group flex min-h-[116px] flex-col items-center gap-3 rounded-2xl border border-gray-100 bg-white p-5 transition-all hover:border-gray-200 hover:shadow-[0_2px_8px_-4px_rgba(0,0,0,0.08)]";

          if (action.external) {
            return (
              <a
                key={action.label}
                href={action.href}
                target="_blank"
                rel="noreferrer"
                className={className}
              >
                {content}
              </a>
            );
          }

          return (
            <Link key={action.label} href={action.href} className={className}>
              {content}
            </Link>
          );
        })}
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-2xl border border-gray-100 bg-white p-6">
          <h2 className="mb-2 text-[15px] tracking-[-0.2px] text-gray-900">
            Cloud workspace control
          </h2>
          <p className="max-w-[620px] text-[13px] leading-[1.7] text-gray-500">
            Launch shared workspaces, manage access, and connect teammates to hosted OpenWork workers from this dashboard.
          </p>
          <Link
            href={getBackgroundAgentsRoute(orgSlug)}
            className="mt-5 inline-flex rounded-full bg-gray-900 px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-gray-800"
          >
            Open shared workspaces
          </Link>
        </div>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 p-5">
            <h3 className="mb-2 text-[14px] text-white">Desktop app</h3>
            <p className="mb-4 text-[13px] leading-[1.6] text-gray-300">
              Run locally for free, keep your data on your machine, and move to shared web workflows when your team is ready.
            </p>
            <a
              href="https://openworklabs.com/download"
              className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-[12px] text-white transition-colors hover:bg-white/10"
            >
              <Monitor className="h-3.5 w-3.5" />
              Use desktop only
            </a>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-5">
            <h3 className="mb-1 text-[14px] text-gray-900">Workspace snapshot</h3>
            <div className="mt-4 grid gap-3">
              <div className="flex items-center justify-between text-[13px] text-gray-500">
                <span>Members</span>
                <span className="font-medium text-gray-900">{orgContext?.members.length ?? 0}</span>
              </div>
              <div className="flex items-center justify-between text-[13px] text-gray-500">
                <span>Pending invites</span>
                <span className="font-medium text-gray-900">
                  {(orgContext?.invitations ?? []).filter((invitation) => invitation.status === "pending").length}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
