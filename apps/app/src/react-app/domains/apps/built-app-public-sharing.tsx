import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Lock } from "lucide-react";
import { DenApiError, type DenBuiltMcpAppPublicSharing, type DenClient } from "@/app/lib/den";
import { openDesktopUrl } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function BuiltAppPublicSharing({ client, orgId, appId }: {
  client: DenClient;
  orgId: string;
  appId: string;
}) {
  const dialogInstanceId = useId();
  const queryClient = useQueryClient();
  const queryKey = ["built-app-public-sharing", orgId, appId, dialogInstanceId];
  const query = useQuery({
    queryKey,
    queryFn: () => client.getBuiltMcpAppPublicSharing(orgId, appId),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const mutation = useMutation({
    mutationFn: (body: { public: boolean; expectedRevisionId: string }) => client.setBuiltMcpAppPublicSharing(orgId, appId, body),
    retry: false,
  });
  const [linkStatus, setLinkStatus] = useState<"copied" | "copy-failed" | "open-failed" | null>(null);

  function changeSharing(makePublic: boolean, expectedRevisionId: string) {
    setLinkStatus(null);
    mutation.mutate({ public: makePublic, expectedRevisionId }, {
      onSuccess: (sharing) => queryClient.setQueryData(queryKey, sharing),
    });
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setLinkStatus("copied");
    } catch {
      setLinkStatus("copy-failed");
    }
  }

  if (query.isPending || query.isFetching) return (
    <div className="space-y-3" role="status" aria-label="Checking the public link">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-8 w-36" />
    </div>
  );
  const error = mutation.error ?? query.error;
  const status = error instanceof DenApiError ? error.status : null;
  if (status === 403 || status === 404) return (
    <div className="flex items-center gap-2 text-muted-foreground" role="status">
      <Lock className="size-4 shrink-0" />
      <p>Public sharing is unavailable. If you need a link, ask someone who manages this artifact.</p>
    </div>
  );
  if (error || !query.data) return (
    <div className="space-y-3">
      <p role="alert" className="text-destructive">{status === 409
        ? "This artifact changed. Check the public link before trying again."
        : mutation.isError
          ? "Could not confirm the change. Check the public link before trying again."
          : "Could not check the public link. Try again."}</p>
      <Button variant="outline" size="sm" onClick={() => {
        mutation.reset();
        void query.refetch();
      }}>Check public link</Button>
    </div>
  );

  const { publicUrl, revisionId, canPublish, blockedBy } = query.data;
  const saving = mutation.isPending;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="font-medium" role="status">{publicUrl ? "Public link is on" : "Public link is off"}</p>
        <p className="text-muted-foreground">Anyone with the link can see the published version’s content. It won’t use connected tools or fetch live data.</p>
      </div>
      {publicUrl ? (
        <>
          <p className="select-all break-all rounded-md border px-3 py-2 text-xs text-muted-foreground">{publicUrl}</p>
          <p className="text-xs text-muted-foreground">The same link opens in a browser and works as an MCP endpoint.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={saving} onClick={() => void copyLink(publicUrl)}>
              <Copy className="size-4" />Copy link
            </Button>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => {
              setLinkStatus(null);
              void openDesktopUrl(publicUrl).catch(() => setLinkStatus("open-failed"));
            }}><ExternalLink className="size-4" />Open in browser</Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => void changeSharing(false, revisionId)}>
              {saving ? "Turning off…" : "Turn off public link"}
            </Button>
          </div>
          {linkStatus === "copied" ? <p role="status" className="text-muted-foreground">Link copied.</p> : null}
          {linkStatus === "copy-failed" ? <p role="alert" className="text-destructive">Could not copy the link. Select and copy the URL above.</p> : null}
          {linkStatus === "open-failed" ? <p role="alert" className="text-destructive">Could not open your browser. Copy the link and open it there.</p> : null}
        </>
      ) : (
        <>
          {!canPublish ? <p className="flex items-center gap-2 text-muted-foreground"><Lock className="size-4 shrink-0" />{blockedBy === "storage" ? "This artifact saves data, so it can't have a public link." : "This artifact uses connected tools. Ask its editor to remove them before publishing."}</p> : null}
          <Button size="sm" disabled={saving || !canPublish} onClick={() => void changeSharing(true, revisionId)}>
            {saving ? "Publishing…" : "Publish public link"}
          </Button>
        </>
      )}
    </div>
  );
}
