"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LockKeyhole, RefreshCw } from "lucide-react";
import { billingInvoicesResponseSchema, type BillingInvoice } from "@openwork/types/den/billing-invoices";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { formatMoneyMinor, getRequestError, requestJson } from "../../_lib/den-flow";
import { getBillingRoute, getOrgAccessFlags, permissionLockReason } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { FeatureIntroGate } from "../_features/feature-intros/feature-intro-gate";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { BillingInvoiceRow, BillingInvoiceRowSkeleton } from "./billing-invoice-row";

function formatInvoiceDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

type InvoicePage = { invoices: BillingInvoice[]; nextCursor: string | null };

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; invoices: BillingInvoice[]; nextCursor: string | null }
  | { kind: "error"; message: string };

const SKELETON_ROWS = [0, 1, 2, 3];

export function BillingInvoicesScreen() {
  const { activeOrg, orgContext, runReauthableAction } = useOrgDashboard();
  const activeOrgId = orgContext?.organization.id ?? null;
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.currentMember.permissions,
  );
  const canSeeInvoices = access.canViewInvoices;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  async function fetchPage(cursor: string | null): Promise<InvoicePage | null> {
    const expectedOrgId = activeOrgId;
    if (!expectedOrgId) return null;
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    const path = `/v1/billing/stripe/invoices${cursor ? `?${query.toString()}` : ""}`;
    const result: { page: InvoicePage | null } = { page: null };
    // Invoices need the View invoices permission, which asks for a recent sign-in.
    await runReauthableAction("billing-invoices", async () => {
      const { response, payload } = await requestJson(path, { method: "GET", headers: { [ORG_SCOPE_HEADER]: expectedOrgId } }, 15000);
      if (!response.ok) throw getRequestError(payload, response, "Stripe didn't return your invoices.");
      const parsed = billingInvoicesResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Stripe didn't return your invoices.");
      result.page = { invoices: parsed.data.invoices, nextCursor: parsed.data.nextCursor };
    });
    return result.page;
  }

  async function loadFirstPage() {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState({ kind: "loading" });
    setLoadMoreError(null);
    try {
      const page = await fetchPage(null);
      if (requestIdRef.current !== requestId || !page) return;
      setState({ kind: "ready", invoices: page.invoices, nextCursor: page.nextCursor });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setState({ kind: "error", message: error instanceof Error ? error.message : "Stripe didn't return your invoices." });
    }
  }

  async function loadMore() {
    if (state.kind !== "ready" || !state.nextCursor) return;
    const requestId = requestIdRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchPage(state.nextCursor);
      if (requestIdRef.current !== requestId || !page) return;
      // Keep the rows already on screen and add the older ones below (P11).
      setState((current) => current.kind === "ready"
        ? { kind: "ready", invoices: [...current.invoices, ...page.invoices], nextCursor: page.nextCursor }
        : current);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setLoadMoreError(error instanceof Error ? error.message : "Older invoices didn't load.");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!activeOrgId || !canSeeInvoices) return;
    void loadFirstPage();
  }, [activeOrgId, canSeeInvoices]);

  const introFacts = state.kind === "ready" ? { invoices: state.invoices.length } : null;

  return (
    <div data-testid="billing-invoices-screen">
      <DashboardPageTemplate title="Invoices" description={null}>
        <div className="-mt-4 mb-6">
          <Link
            href={getBillingRoute(activeOrg?.slug)}
            className="inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium text-gray-500 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden="true" />
            Billing
          </Link>
        </div>

        {!canSeeInvoices ? (
          <DenNotice
            tone="neutral"
            icon={LockKeyhole}
            message={`Invoices are locked. ${permissionLockReason("billing_invoices.view")}`}
          />
        ) : state.kind === "error" ? (
          <DenNotice
            message={state.message}
            action={<DenButton variant="secondary" size="sm" icon={RefreshCw} onClick={() => void loadFirstPage()}>Try again</DenButton>}
          />
        ) : (
          <FeatureIntroGate introKey="billing.invoices" facts={introFacts}>
            <DenCard className="!p-0" data-testid="billing-invoices-card">
              <ul className="m-0 list-none divide-y divide-gray-100 p-0 py-1" aria-busy={state.kind === "loading"}>
                {state.kind === "loading"
                  ? SKELETON_ROWS.map((row) => <BillingInvoiceRowSkeleton key={row} />)
                  : state.invoices.map((invoice) => (
                      <BillingInvoiceRow
                        key={invoice.id}
                        date={formatInvoiceDate(invoice.createdAt)}
                        number={invoice.number}
                        amount={formatMoneyMinor(invoice.total, invoice.currency)}
                        status={invoice.status}
                        href={invoice.hostedInvoiceUrl}
                      />
                    ))}
              </ul>
              {state.kind === "ready" && state.invoices.length === 0 ? (
                // Shown only when feature intros are off; otherwise the intro box replaces the list (I1).
                <p className="px-6 py-5 text-[13px] text-gray-500">No invoices yet. Stripe sends one when a paid plan starts.</p>
              ) : null}
              {state.kind === "ready" && state.nextCursor ? (
                <div className="flex flex-col items-center gap-2 border-t border-gray-100 px-6 py-3">
                  {loadMoreError ? <p className="text-[13px] text-red-600" role="alert">{loadMoreError}</p> : null}
                  <DenButton variant="ghost" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                    {loadMoreError ? "Try again" : "Show older invoices"}
                  </DenButton>
                </div>
              ) : null}
            </DenCard>
          </FeatureIntroGate>
        )}
      </DashboardPageTemplate>
    </div>
  );
}
