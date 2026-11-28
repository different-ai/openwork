import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink } from "lucide-react";
import { DenApiError, markFeatureUsed, type DenClient } from "@/app/lib/den";
import { openDesktopUrl } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type BuiltAppShareLinkTarget = { client: DenClient; orgId: string; appId: string };

export function BuiltAppShareLink({ client, orgId, appId, scope }: BuiltAppShareLinkTarget & { scope: readonly unknown[] }) {
  const features = useQuery({
    queryKey: ["built-app-share-link-feature", orgId, ...scope],
    queryFn: () => client.getOrgFeatures(orgId),
    staleTime: 60_000,
  });
  if (features.data?.artifactShareLinks !== true) return null;
  return <OrganizationLink client={client} orgId={orgId} appId={appId} />;
}

function OrganizationLink({ client, orgId, appId }: BuiltAppShareLinkTarget) {
  const dialogInstanceId = useId();
  const query = useQuery({
    queryKey: ["built-app-share-link", orgId, appId, dialogInstanceId],
    queryFn: () => client.getBuiltMcpAppShareLink(orgId, appId),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [linkStatus, setLinkStatus] = useState<"copied" | "copy-failed" | "open-failed" | null>(null);

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      setLinkStatus("copy-failed");
      return;
    }
    setLinkStatus("copied");
    markFeatureUsed("artifactShareLinks");
  }

  if (query.isPending || query.isFetching) return (
    <div className="space-y-3" role="status" aria-label="Checking the organization link">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-8 w-36" />
    </div>
  );
  const error = query.error;
  if (error instanceof DenApiError && error.status === 404 &&
    (error.code === "mcp_app_not_found" || error.code === "feature_disabled")) return null;
  if (error || !query.data) return (
    <div className="space-y-3">
      <p role="alert" className="text-destructive">Could not check the organization link. Try again.</p>
      <Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>
    </div>
  );

  const { url } = query.data;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-medium">Link for your organization</h3>
        <p className="text-muted-foreground">People you share this with can open it in a browser after signing in to OpenWork. They see live data from their own connected tools.</p>
      </div>
      <p className="select-all break-all rounded-md border px-3 py-2 text-xs text-muted-foreground">{url}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void copyLink(url)}><Copy className="size-4" />Copy link</Button>
        <Button variant="outline" size="sm" onClick={() => {
          setLinkStatus(null);
          void openDesktopUrl(url).catch(() => setLinkStatus("open-failed"));
        }}><ExternalLink className="size-4" />Open in browser</Button>
      </div>
      {linkStatus === "copied" ? <p role="status" className="text-muted-foreground">Link copied.</p> : null}
      {linkStatus === "copy-failed" ? <p role="alert" className="text-destructive">Could not copy the link. Select and copy the URL above.</p> : null}
      {linkStatus === "open-failed" ? <p role="alert" className="text-destructive">Could not open your browser. Copy the link and open it there.</p> : null}
    </div>
  );
}
