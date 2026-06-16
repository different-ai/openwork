"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Laptop, Plus } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { getDesktopPolicyRoute, getNewDesktopPolicyRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  deleteDesktopPolicy,
  useOrgDesktopPolicies,
  type DenDesktopPolicy,
} from "./desktop-policy-data";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";

function formatPolicyTimestamp(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function DesktopPoliciesScreen() {
  const { orgId, orgSlug, orgContext, runReauthableAction } = useOrgDashboard();
  const { desktopPolicies, busy, error, reloadPolicies } = useOrgDesktopPolicies(orgId);
  const [deleting, setDeleting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageSuccess, setPageSuccess] = useState<string | null>(null);

  const visiblePolicies = useMemo(() => {
    const list = [...desktopPolicies];
    list.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1;
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aTime - bTime;
    });
    return list;
  }, [desktopPolicies]);
  const canManage = orgContext?.currentMember.isOwner || orgContext?.currentMember.role.split(",").map((role) => role.trim()).includes("admin");

  const softDeletePolicy = async (policy: DenDesktopPolicy) => {
    if (policy.isDefault || !confirm(`Delete ${policy.policyName}?`)) return;
    setPageError(null);
    setPageSuccess(null);
    try {
      await runReauthableAction("delete-desktop-policy", async () => {
        setDeleting(true);
        await deleteDesktopPolicy(policy.id);
        setPageSuccess("Desktop policy deleted.");
        await reloadPolicies();
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Failed to delete desktop policy.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <DashboardPageTemplate
      icon={Laptop}
      title="Desktop policies"
      description="Control which desktop capabilities are available to the whole org, specific members, or teams."
      colors={["#F8FAFC", "#0F172A", "#38BDF8", "#A78BFA"]}
    >
      <div className="mb-6 flex flex-wrap items-center justify-end gap-3">
        {canManage ? (
          <Link href={getNewDesktopPolicyRoute(orgSlug)} className={buttonVariants({ variant: "primary" })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New policy
          </Link>
        ) : null}
      </div>

      {orgContext && !orgContext.entitlements.desktopPolicies ? <EnterprisePlanNotice feature="Desktop policy management" /> : null}
      {pageError ? <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">{pageError}</div> : null}
      {pageSuccess ? <div className="mb-6 rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-[14px] text-emerald-700">{pageSuccess}</div> : null}
      {error ? <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">{error}</div> : null}

      {busy ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">Loading desktop policies...</div>
      ) : visiblePolicies.length === 0 ? (
        <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center text-[15px] text-gray-500">No desktop policies.</div>
      ) : (
        <section className="overflow-hidden rounded-[28px] border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[14px]">
              <colgroup>
                <col />
                <col className="w-[1%]" />
                <col className="w-[1%]" />
                <col className="w-[1%]" />
              </colgroup>
              <thead className="bg-gray-50 text-[12px] uppercase tracking-[0.08em] text-gray-500">
                <tr>
                  <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">Name</th>
                  <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">Enabled</th>
                  <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">Created</th>
                  <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visiblePolicies.map((policy) => {
                  const editHref = getDesktopPolicyRoute(orgSlug, policy.id);
                  return (
                    <tr key={policy.id} className="align-middle">
                      <td className="whitespace-nowrap px-4 py-4">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium text-gray-950">{policy.policyName}</span>
                          {policy.isDefault ? (
                            <span className="inline-flex items-center rounded-full border border-sky-100 bg-sky-50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.1em] leading-none text-sky-700">Default</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-4">
                        <span className={`inline-flex items-center rounded-full px-3 py-1 text-[12px] font-medium ${policy.isEnabled ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                          {policy.isEnabled ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 text-[13px] text-gray-600">
                        {formatPolicyTimestamp(policy.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-4">
                        <div className="flex justify-end gap-2">
                          {canManage ? (
                            <Link href={editHref} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                              Edit
                            </Link>
                          ) : null}
                          {canManage && !policy.isDefault ? (
                            <DenButton type="button" variant="destructive" size="sm" onClick={() => void softDeletePolicy(policy)} disabled={deleting}>Delete</DenButton>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </DashboardPageTemplate>
  );
}
