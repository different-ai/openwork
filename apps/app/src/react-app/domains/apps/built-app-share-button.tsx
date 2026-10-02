import { useState } from "react";
import { Blocks } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useLibraryCloud } from "../settings/use-library-cloud";
import { LibrarySharePage } from "../settings/pages/library-share-page";
import { useAppsClient } from "./use-apps";

export function BuiltAppShareButton({
  pluginId,
  title,
}: {
  pluginId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const context = useAppsClient();
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Share
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader className="sr-only">
            <DialogTitle>Share {title}</DialogTitle>
          </DialogHeader>
          {context.client && context.orgId && context.identityVerified ? (
            <AppSharing
              key={JSON.stringify(context.scope)}
              context={context}
              pluginId={pluginId}
              title={title}
              onClose={() => setOpen(false)}
            />
          ) : (
            <p role="status" className="text-sm">
              Sign in to share this app.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AppSharing({
  context,
  pluginId,
  title,
  onClose,
}: {
  context: ReturnType<typeof useAppsClient>;
  pluginId: string;
  title: string;
  onClose: () => void;
}) {
  // The caller verifies these before mounting. Avoid retaining another member's grants.
  if (!context.client || !context.orgId)
    throw new Error("Sign in to share this app.");
  const library = useLibraryCloud({
    client: context.client,
    organizationId: context.orgId,
    baseUrl: JSON.stringify(context.scope),
    enabled: true,
  });
  if (library.sharingError)
    return (
      <div className="flex items-center gap-2">
        <p role="alert" className="text-sm">
          Sharing could not be loaded.
        </p>
        <Button variant="outline" onClick={() => void library.refresh()}>
          Try again
        </Button>
      </div>
    );
  if (!library.ready || !library.directory)
    return (
      <div role="status" aria-label="Checking sharing">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    );
  const plugin = library.pluginById.get(pluginId);
  if (!plugin || !library.ownedPluginIds.has(pluginId))
    return (
      <p role="status" className="text-sm">
        Only this app's owner can share it. Ask them for access.
      </p>
    );
  if (!library.grantsReadyFor(pluginId))
    return <Skeleton className="h-40 w-full" />;
  return (
    <LibrarySharePage
      name={title}
      description={null}
      taxonomy="plugin"
      icon={<Blocks className="size-4" />}
      directory={library.directory}
      initialAudience={library.audienceFor(pluginId)}
      canShareOrgWide={context.canManage}
      onCancel={onClose}
      onSave={async (targets) => {
        await library.setAudience(pluginId, targets);
        onClose();
      }}
    />
  );
}
