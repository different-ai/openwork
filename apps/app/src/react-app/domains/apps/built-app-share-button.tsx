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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BuiltAppPublicSharing } from "./built-app-public-sharing";
import { BuiltAppShareLink } from "./built-app-share-link";
import { useLibraryCloud } from "../settings/use-library-cloud";
import { LibrarySharePage } from "../settings/pages/library-share-page";
import { useAppsClient } from "./use-apps";

type BuiltAppShareTarget = { appId: string; pluginId: string; title: string };

export function BuiltAppShareButton({ appId, pluginId, title }: BuiltAppShareTarget) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Share
      </Button>
      <BuiltAppShareDialog appId={appId} pluginId={pluginId} title={title} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function BuiltAppShareDialog({
  appId,
  pluginId,
  title,
  open,
  onOpenChange,
}: BuiltAppShareTarget & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const context = useAppsClient();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Share {title}</DialogTitle>
        </DialogHeader>
        {open && (context.client && context.orgId && context.identityVerified ? (
          <Tabs key={JSON.stringify([...context.scope, appId, pluginId])} defaultValue="organization">
            <TabsList aria-label="Sharing audience" variant="line">
              <TabsTrigger value="organization">Within your organization</TabsTrigger>
              <TabsTrigger value="public">Public link</TabsTrigger>
            </TabsList>
            <TabsContent value="organization" keepMounted className="space-y-4 pt-2">
              <BuiltAppShareLink client={context.client} orgId={context.orgId} appId={appId} scope={context.scope} />
              <AppSharing context={context} pluginId={pluginId} title={title} onClose={() => onOpenChange(false)} />
            </TabsContent>
            <TabsContent value="public" keepMounted className="pt-2">
              <BuiltAppPublicSharing client={context.client} orgId={context.orgId} appId={appId} />
            </TabsContent>
          </Tabs>
        ) : (
          <p role="status" className="text-sm">
            Sign in to share this artifact.
          </p>
        ))}
      </DialogContent>
    </Dialog>
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
  if (!context.client || !context.orgId)
    throw new Error("Sign in to share this artifact.");
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
        Only this artifact's owner can share it. Ask them for access.
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
