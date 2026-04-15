"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import {
  BookOpen,
  Bot,
  CreditCard,
  Cpu,
  FileText,
  Home,
  KeyRound,
  LogOut,
  MessageSquare,
  Share2,
  Users,
} from "lucide-react";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import {
  formatRoleLabel,
  getBackgroundAgentsRoute,
  getApiKeysRoute,
  getBillingRoute,
  getCustomLlmProvidersRoute,
  getOrgAccessFlags,
  getMembersRoute,
  getOrgDashboardRoute,
  getSharedSetupsRoute,
  getSkillHubsRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { OPENWORK_DOCS_URL, buildDenFeedbackUrl } from "./shared-setup-data";

function OrgMark({ name }: { name: string }) {
  const initials = useMemo(() => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return (parts[0]?.slice(0, 1) ?? "O") + (parts[1]?.slice(0, 1) ?? "");
  }, [name]);

  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#011627] text-xs font-semibold uppercase tracking-[0.08em] text-white">
      {initials}
    </div>
  );
}

function OpenWorkMark({ className = "h-9 w-auto" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 834 649"
      fill="none"
      className={className}
      aria-label="OpenWork"
    >
      <path
        fill="#011627"
        d="M445.095 7.09371C465.376 6.15629 479.12 14.7057 495.962 24.2006L526.535 41.3366L562.91 61.6421C572.209 66.8088 584.43 72.9805 592.216 79.7283C605.112 90.9218 613.007 107.518 613.57 124.621C613.997 137.564 613.785 151.186 613.771 164.285L613.743 233.167L613.724 302.115C613.724 328.043 615.147 351.097 609.112 376.5C602.601 403.733 589.274 428.855 570.372 449.495C549.311 472.84 531.218 480.587 504.269 495.433L435.717 533.297L369.268 570.017C349.148 581.007 338.445 590.166 314.978 591.343C295.336 592.765 280.624 583.434 264.332 574.332L231.209 555.796L197.159 536.707C188.064 531.606 176.78 525.84 169.138 519.247C155.537 507.509 147.236 489.12 146.689 471.221C146.261 457.224 146.479 442.102 146.479 427.951L146.495 345.546L146.52 273.548C146.53 254.27 145.49 230.956 149.51 212.464C154.532 189.864 165.167 168.888 180.427 151.489C188.245 142.605 197.223 134.814 207.121 128.324C220.854 119.307 239.559 109.953 254.414 101.931L324.032 63.8708L377.708 34.3028C389.942 27.4909 403.011 19.8636 415.79 14.2429C424.983 10.1982 434.435 8.96958 445.095 7.09371Z"
      />
      <path
        fill="#FFFFFF"
        d="M551.317 90.4398C557.678 89.5674 565.764 91.1466 571.495 93.8628C579.57 97.6845 585.756 104.611 588.643 113.063C593.053 125.734 591.473 156.67 591.443 171.112L591.314 249.733L591.238 310.947C591.227 325.186 591.691 340.89 590.054 354.92C588.069 370.594 583.473 385.826 576.46 399.982C555.363 442.986 527.973 455.45 488.286 477.122L422.355 513.332L365.248 544.928C353.229 551.61 337.931 561.062 325.256 565.404C303.927 570.03 288.668 560.584 286.41 537.983C285.155 525.413 285.813 512.071 285.819 499.363L285.877 428.201L285.838 335.271C285.834 319.126 284.849 293.286 287.551 278.43C291.03 259.848 299.063 242.413 310.931 227.699C318.408 218.335 327.295 210.186 337.275 203.548C346.99 197.101 362.755 189.212 373.491 183.383L431.093 151.71L500.183 113.742C508.673 109.063 517.232 104.321 525.662 99.5446C534.307 94.6455 540.968 91.4752 551.317 90.4398Z"
      />
      <path
        fill="#011627"
        d="M500.082 178.001C526.778 177.772 523.894 205.211 523.884 223.719L523.898 262.499L523.914 317.09C523.91 328.358 524.422 343.13 522.698 354.018C520.708 366.296 516.186 378.028 509.412 388.459C503.656 397.432 496.335 405.297 487.795 411.689C481.432 416.447 474.925 419.72 467.987 423.536L442.835 437.398L405.739 457.871C398 462.106 386.024 469.486 377.74 471.261L377.429 471.295C371.837 471.855 366.369 470.989 361.995 467.199C353.196 459.977 353.708 447.985 353.675 437.935C353.658 432.922 353.668 427.909 353.67 422.896L353.695 376.464L353.657 326.944C353.647 313.866 353.091 297.438 355.615 284.836C358.159 272.209 363.878 260.447 372.266 250.342C376.745 244.958 381.997 240.295 387.801 236.377C393.985 232.272 401.996 228.073 408.612 224.459L440.329 207.201L468.44 191.684C477.65 186.588 489.038 179.021 500.082 178.001Z"
      />
      <path
        fill="#FFFFFF"
        d="M500.225 291.464L500.59 291.556C501.213 292.643 501.002 340.865 500.638 345.536C500.306 350.339 499.443 355.09 498.065 359.703C494.788 370.842 488.588 380.902 480.112 388.834C472.165 396.184 462.79 400.931 453.37 406.067L431.052 418.227L377.328 447.628L376.894 447.414C376.568 445.467 376.757 441.034 376.763 438.896L376.794 421.911C376.893 401.013 376.885 380.115 376.77 359.217C382.142 355.849 390.96 351.452 396.691 348.372L427.925 331.276L469.656 308.362C479.711 302.761 490.055 296.768 500.225 291.464Z"
      />
      <path
        fill="#FFFFFF"
        d="M497.337 201.62C500.344 201.36 500.962 203.237 501.131 205.91C501.599 213.274 501.389 220.747 501.367 228.135L501.431 265.103C460.969 287.74 420.329 310.058 379.523 332.068L376.452 333.794C376.365 312.962 373.253 285.726 386.024 268.182C393.365 258.104 404.145 253.143 414.788 247.296L441.211 232.769L476.823 212.874C483.353 209.216 490.623 204.921 497.337 201.62Z"
      />
      <path
        fill="#FFFFFF"
        d="M443.216 29.48C452.02 29.0815 460.018 30.0261 467.903 34.1434C489.625 45.4892 510.693 58.4477 532.373 69.8693C514.905 78.2946 493.564 90.995 476.372 100.542L386.895 149.628C376.357 155.498 365.774 161.287 355.148 166.992C337.373 176.588 322.776 183.695 307.595 197.464C287.772 215.608 273.675 239.14 267.014 265.17C262.116 284.284 262.909 298.302 262.917 317.836L262.939 357.47L262.926 471.524L262.961 530.447C262.98 532.198 263.562 543.941 263.164 544.751L262.58 544.549L215.582 518.061C189.232 503.261 169.189 495.747 169.845 460.795C170.068 448.934 169.804 435.617 169.812 423.605L169.831 344.391L169.818 269.769C169.814 254.383 168.977 231.859 171.873 217.311C175.825 198.048 184.641 180.127 197.478 165.236C204.056 157.596 211.686 150.929 220.143 145.432C231.916 137.708 249.246 128.979 262.061 121.995L328.787 85.3185L391.28 50.97C401.594 45.3095 412 39.3027 422.528 34.3441C428.812 31.3849 436.148 30.2484 443.216 29.48Z"
      />
    </svg>
  );
}

function getDashboardPageTitle(pathname: string, orgSlug: string | null) {
  if (!orgSlug) {
    return "Home";
  }

  const dashboardRoot = getOrgDashboardRoute(orgSlug);

  if (pathname === dashboardRoot) {
    return "Home";
  }
  if (pathname.startsWith(getSharedSetupsRoute(orgSlug))) {
    return "Team Templates";
  }
  if (pathname.startsWith(getMembersRoute(orgSlug))) {
    return "Members";
  }
  if (pathname.startsWith(getApiKeysRoute(orgSlug))) {
    return "API Keys";
  }
  if (pathname.startsWith(getBackgroundAgentsRoute(orgSlug))) {
    return "Shared Workspaces";
  }
  if (pathname.startsWith(getCustomLlmProvidersRoute(orgSlug))) {
    return "LLM Providers";
  }
  if (pathname.startsWith(getSkillHubsRoute(orgSlug))) {
    return "Skill Hubs";
  }
  if (pathname.startsWith(getBillingRoute(orgSlug)) || pathname === "/checkout") {
    return "Billing";
  }

  return "Home";
}

export function OrgDashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useDenFlow();
  const {
    activeOrg,
    orgDirectory,
    orgContext,
    orgBusy,
    orgError,
    switchOrganization,
  } = useOrgDashboard();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
  );

  const pageTitle = getDashboardPageTitle(pathname, activeOrg?.slug ?? null);
  const feedbackHref = buildDenFeedbackUrl({
    pathname,
    orgSlug: activeOrg?.slug,
  });

  const navItems = [
    {
      href: activeOrg ? getOrgDashboardRoute(activeOrg.slug) : "#",
      label: "Dashboard",
      icon: Home,
    },
    {
      href: activeOrg ? getSharedSetupsRoute(activeOrg.slug) : "#",
      label: "Team Templates",
      icon: Share2,
    },
    {
      href: activeOrg ? getBackgroundAgentsRoute(activeOrg.slug) : "#",
      label: "Shared Workspace",
      icon: Bot,
      badge: "Alpha",
    },
      {
        href: activeOrg ? getCustomLlmProvidersRoute(activeOrg.slug) : "#",
        label: "LLM Providers",
        icon: Cpu,
        badge: "New",
      },
    {
      href: activeOrg ? getSkillHubsRoute(activeOrg.slug) : "#",
      label: "Skill Hubs",
      icon: BookOpen,
      badge: "New",
    },
    {
      href: activeOrg ? getMembersRoute(activeOrg.slug) : "#",
      label: "Members",
      icon: Users,
    },
    ...(access.canManageApiKeys
      ? [{
          href: activeOrg ? getApiKeysRoute(activeOrg.slug) : "#",
          label: "API Keys",
          icon: KeyRound,
        }]
      : []),
    {
      href: activeOrg ? getBillingRoute(activeOrg.slug) : "/checkout",
      label: "Billing",
      icon: CreditCard,
    },
  ];

  const orgSwitcher = (
    <div className="relative">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-gray-100"
        onClick={() => setSwitcherOpen((current) => !current)}
      >
        <div className="flex min-w-0 items-center gap-3">
          <OrgMark name={activeOrg?.name ?? "OpenWork"} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-medium text-gray-900">
              {activeOrg?.name ?? "Loading..."}
            </p>
            <p className="truncate text-[12px] text-gray-500">
              {activeOrg ? formatRoleLabel(activeOrg.role) : "Preparing workspace"}
            </p>
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0">
          <path d="M17 3l4 4-4 4"/>
          <path d="M3 7h18"/>
          <path d="M7 21l-4-4 4-4"/>
          <path d="M21 17H3"/>
        </svg>
      </button>

      {switcherOpen ? (
        <div className="absolute bottom-[calc(100%+0.5rem)] left-0 w-[240px] z-30 grid gap-1 rounded-2xl border border-gray-200 bg-white py-2 shadow-[0_12px_24px_-12px_rgba(0,0,0,0.15)]">
          <div className="px-3 py-1.5">
            <p className="truncate text-[13px] font-medium text-gray-900">
              {user?.email ?? "OpenWork user"}
            </p>
          </div>
          
          <div className="mx-2 h-px bg-gray-100 my-1" />

          <div className="px-3 pb-1 pt-1">
            <p className="text-[11px] font-medium text-gray-500">
              Switch workspace
            </p>
          </div>
          
          <div className="grid gap-0.5 px-1.5">
            {orgDirectory.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => {
                  setSwitcherOpen(false);
                  switchOrganization(org.slug);
                }}
                className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  org.isActive
                    ? "bg-gray-50 text-gray-900"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="min-w-0">
                    <span className="block truncate text-[13px] font-medium tracking-[-0.1px]">{org.name}</span>
                    <span className="block truncate text-[12px] text-gray-500">
                      {org.role === "owner" ? "Creator plan" : "Free plan"} • 1 member
                    </span>
                  </div>
                </div>
                {org.isActive ? (
                  <svg className="h-4 w-4 shrink-0 text-gray-900" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : null}
              </button>
            ))}
          </div>

          <div className="px-1.5 mt-0.5">
            <Link
              href="/organization"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
              onClick={() => setSwitcherOpen(false)}
            >
              <span className="text-gray-400 text-[16px] leading-none">+</span> Create or join workspace
            </Link>
          </div>

          <div className="mx-2 h-px bg-gray-100 my-1" />

          <div className="px-1.5">
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
            >
              <LogOut className="h-4 w-4 text-gray-400" />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col bg-[#fafafa] md:flex-row">
      <aside className="w-full shrink-0 border-b border-gray-100 bg-white md:flex md:min-h-screen md:w-[260px] md:flex-col md:border-b-0 md:border-r">
        <div className="flex flex-1 flex-col">
          <div className="border-b border-gray-100 px-4 pb-4 pt-5">
            <div className="flex items-center justify-between gap-3">
              <OpenWorkMark />
              {orgBusy ? <span className="text-xs text-gray-400">Refreshing...</span> : null}
            </div>
          </div>

          <nav className="flex-1 px-3 py-5">
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              Navigation
            </p>
            <div className="space-y-1">
              {navItems.map((item) => {
                const isDashboardRoot =
                  activeOrg && item.href === getOrgDashboardRoute(activeOrg.slug);
                const selected =
                  item.href !== "#" &&
                  (isDashboardRoot
                    ? pathname === item.href
                    : pathname === item.href || pathname.startsWith(`${item.href}/`));

                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-[13px] tracking-[-0.1px] transition-colors ${
                      selected
                        ? "bg-gray-100 text-gray-900"
                        : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <item.icon className="h-4 w-4" strokeWidth={1.8} />
                      {item.label}
                    </span>
                    {item.badge ? (
                      <span className="rounded-full bg-white px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </nav>

          <div className="mt-auto p-3">
            {orgSwitcher}

            {orgBusy ? (
              <p className="mt-3 px-2 text-[11px] text-gray-400">Refreshing workspace…</p>
            ) : null}
            {orgError ? (
              <p className="mt-3 px-2 text-[11px] font-medium text-rose-600">{orgError}</p>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 bg-white px-5 md:px-6">
          <div className="flex items-center gap-2">
            <span className="text-[14px] tracking-[-0.1px] text-gray-900">
              {pageTitle}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <a
              href={feedbackHref}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
            >
              <MessageSquare className="h-4 w-4" />
              Feedback
            </a>
            <a
              href={OPENWORK_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
            >
              <FileText className="h-4 w-4" />
              Docs
            </a>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-[#fafafa]">{children}</main>
      </div>
    </div>
  );
}
