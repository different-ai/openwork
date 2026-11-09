"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { UnderlineTabs } from "../../../_components/ui/tabs";
import { type ConfigTab, getConfigRoute } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useConfigChangeRequests } from "./config-blobs-data";
import { ConfigChangeList } from "./config-change-list";
import { ConfigExportSection } from "./config-export-section";
import { ConfigImportSection } from "./config-import-section";
import { ConfigSettingsSection } from "./config-settings-section";
import { useConfigBlobsFeature } from "./config-blobs-parts";

function readTab(value: string | null): ConfigTab {
  return value === "changes" || value === "history" ? value : "overview";
}

/** Settings › Config: export the organization's configuration, import a file as a change request, and follow requests. */
export function ConfigScreen() {
  const { ready } = useConfigBlobsFeature();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgId, activeOrg } = useOrgDashboard();
  const tab = readTab(searchParams.get("tab"));
  const open = useConfigChangeRequests(ready ? orgId : null, "open");
  const openCount = open.data?.changeRequests.length;

  if (!ready) return null;

  return (
    <section className="mx-auto flex w-full min-w-0 max-w-[860px] flex-col gap-6 p-4 sm:p-6 md:p-8" data-testid="config-screen">
      <DenPageHeader title="Config" size="compact" />
      <UnderlineTabs
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "changes", label: "Changes", count: openCount },
          { value: "history", label: "History" },
        ]}
        activeTab={tab}
        onChange={(next) => router.replace(getConfigRoute(activeOrg?.slug, next))}
      />
      {tab === "overview" ? (
        <div className="flex flex-col gap-10">
          <ConfigExportSection />
          <div className="border-t border-gray-100" />
          <ConfigImportSection />
          <div className="border-t border-gray-100" />
          <ConfigSettingsSection />
        </div>
      ) : tab === "changes" ? (
        <ConfigChangeList state="open" emptyMessage="No changes waiting. Import a config file from Overview to start one." />
      ) : (
        <ConfigChangeList state="closed" emptyMessage="Nothing applied or closed yet. Applied changes show here with a copy of what they replaced." />
      )}
    </section>
  );
}
