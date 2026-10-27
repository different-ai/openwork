"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Building2, ChartNoAxesCombined, Flag, FlaskConical, LayoutDashboard, ScanSearch, Server, ShieldAlert, Users } from "lucide-react";
import { AdminBreadcrumbs } from "./admin-breadcrumbs";
import { AdminAccessScreen } from "./admin-access-screen";
import { requestAdmin, withStoredBearer, type AdminResult } from "./admin-request";

const SessionCookieContext = createContext(false);
export const useAdminSessionCookie = () => useContext(SessionCookieContext);

const SECTIONS = [
  { label: "Overview", href: "/admin", icon: LayoutDashboard },
  { label: "Users", href: "/admin/users", icon: Users },
  { label: "Organizations", href: "/admin/organizations", icon: Building2 },
  { label: "Opportunities", href: "/admin/opportunities", icon: ScanSearch },
  { label: "Sandboxes", href: "/admin/sandbox-orgs", icon: FlaskConical },
  { label: "Feature rollouts", href: "/admin/features", icon: Flag },
  { label: "Free Auto usage", href: "/admin/free-auto", icon: ChartNoAxesCombined },
  { label: "Security", href: "/admin/security", icon: ShieldAlert },
  { label: "Services", href: "/admin/services", icon: Server },
];

export function AdminShell({ hasSessionCookie, children }: { hasSessionCookie: boolean; children: ReactNode }) {
  // Check access once per admin visit. Keying the gate by pathname re-ran the
  // check and remounted every page on each click; each data endpoint still
  // authorizes itself and pages show the access screen when it fails.
  return (
    <SessionCookieContext.Provider value={hasSessionCookie}>
      <AdminAccessGate hasSessionCookie={hasSessionCookie}>
        <AdminShellContent>{children}</AdminShellContent>
      </AdminAccessGate>
    </SessionCookieContext.Provider>
  );
}

function AdminAccessGate({ hasSessionCookie, children }: { hasSessionCookie: boolean; children: ReactNode }) {
  const [state, setState] = useState<AdminResult<true> | { access: "checking" }>({ access: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!hasSessionCookie && !withStoredBearer({}).Authorization) {
      setState({ access: "signed-out", message: "" });
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort();
      setState({ access: "error", message: "Could not check admin access. Retry to check your access." });
    }, 12_000);
    setState({ access: "checking" });
    // A cookie/token is only a hint. Confirm the platform allowlist before
    // mounting navigation or any page. Each data endpoint still authorizes itself.
    void requestAdmin<true>("/v1/admin/features", payload =>
      payload && typeof payload === "object" && "features" in payload && Array.isArray(payload.features) ? true : null,
    controller.signal).then(result => {
      if (!controller.signal.aborted) setState(result);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ access: "error", message: error instanceof Error ? error.message : "Could not check admin access." });
    }).finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [hasSessionCookie, attempt]);

  if (state.access === "ready") return children;
  return (
    <main id="admin-content" className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-8">
      <div className="w-full">
        <AdminAccessScreen state={state.access} message={"message" in state ? state.message : undefined} onRetry={() => setAttempt(value => value + 1)} />
      </div>
    </main>
  );
}

function AdminShellContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const section = SECTIONS.find(({ href }) => href === "/admin" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
  const organizationDetail = pathname.startsWith("/admin/organizations/");
  return (
      <div className="min-h-screen bg-white">
        <a href="#admin-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3">Skip to content</a>
        <aside className="flex flex-col border-b border-slate-200 bg-slate-50/60 md:fixed md:inset-y-0 md:w-52 md:overflow-y-auto md:border-b-0 md:border-r">
          <div className="shrink-0 px-5 py-5">
            <Link href="/admin" prefetch={false} className="text-sm font-semibold text-gray-900">OpenWork admin</Link>
          </div>
          <nav aria-label="Admin navigation" data-testid="admin-navigation" className="grid grid-cols-2 gap-1 px-3 pb-3 sm:grid-cols-3 md:flex md:shrink-0 md:flex-col">
            {SECTIONS.map(({ label, href, icon: Icon }) => {
              const active = href === "/admin" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link key={href} href={href} prefetch={false} aria-current={active ? pathname === href ? "page" : "location" : undefined}
                  data-testid={`admin-nav-${href === "/admin" ? "overview" : href.split("/").at(-1)}`}
                  className={`flex min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 ${active ? "bg-slate-100 text-slate-950" : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"}`}>
                  <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0">{label}</span>
                </Link>
              );
            })}
          </nav>
          <Link href="/" prefetch={false} className="flex shrink-0 items-center gap-2 px-6 py-4 text-sm text-slate-600 hover:text-slate-950 md:mt-auto">
            <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />Back to cloud panel
          </Link>
        </aside>
        <div className="md:pl-52">
          <main id="admin-content" className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
            {!organizationDetail && section ? <AdminBreadcrumbs items={[{ id: "admin", label: "Admin", href: "/admin" }, { id: "section", label: section.label }]} /> : null}
            {children}
          </main>
        </div>
      </div>
  );
}
