"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { UnderlineTabs } from "../../../_components/ui/tabs";
import { type ConfigTab, getConfigRoute, readConfigTab } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useConfigChangeRequests } from "./config-blobs-data";
import { ConfigChangeList } from "./config-change-list";
import { ConfigExportSection } from "./config-export-section";
import { ConfigImportSection } from "./config-import-section";
import { ConfigOverviewSection } from "./config-overview-section";
import { ConfigSettingsSection } from "./config-settings-section";
import { useConfigBlobsFeature } from "./config-blobs-parts";

/** Settings › Config: an overview, then import, export, open changes and history, one tab each (`?tab=`). */
export function ConfigScreen() {
  const { ready } = useConfigBlobsFeature();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgId, activeOrg } = useOrgDashboard();
  const tab = readConfigTab(searchParams.get("tab"));
  const open = useConfigChangeRequests(ready ? orgId : null, "open");
  const openCount = open.data?.changeRequests.length;

  if (!ready) return null;

  const openTab = (next: ConfigTab) => router.replace(getConfigRoute(activeOrg?.slug, next));

  return (
    <section className="mx-auto flex w-full min-w-0 max-w-[860px] flex-col gap-6 p-4 sm:p-6 md:p-8" data-testid="config-screen">
      <DenPageHeader title="Config" size="compact" />
      <UnderlineTabs
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "import", label: "Import" },
          { value: "export", label: "Export" },
          { value: "changes", label: "Changes", count: openCount },
          { value: "history", label: "History" },
        ]}
        activeTab={tab}
        onChange={openTab}
      />
      {tab === "overview" ? (
        <ConfigOverviewSection onOpenTab={openTab} />
      ) : tab === "import" ? (
        <ConfigImportSection />
      ) : tab === "export" ? (
        <ConfigExportSection />
      ) : tab === "changes" ? (
        <div className="flex flex-col gap-6">
          <ConfigSettingsSection />
          <ConfigChangeList state="open" emptyMessage="No changes waiting. Import a config file to start one." />
        </div>
      ) : (
        <ConfigChangeList state="closed" emptyMessage="Nothing applied or closed yet. Applied changes show here with a copy of what they replaced." />
      )}
    </section>
  );
}
