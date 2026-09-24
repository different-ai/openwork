"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import type { DenOrgContext } from "../../_lib/den-org";
import { getLibraryConnectorRoute, getLibraryPluginRoute, getLibraryRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type AccessDraft,
  accessPeopleIds,
  peopleLabel,
  pluginShareSubtitle,
  sameAccess,
  shareConsequence,
  sharedToastDescription,
} from "./access-summary";
import { useDenToast } from "./den-toast";
import { ItemHeader, ItemPage, SectionTitle, StepFooter } from "./item-header";
import { LinkButton } from "./item-list";
import { ConnectorLogo, LetterTile } from "./item-logo";
import { draftFromPluginGrants, useSaveConnectionAccess, useSavePluginAccess } from "./item-sharing";
import { useMcpConnections } from "./mcp-connections-data";
import { usePluginAccess } from "./plugin-access-data";
import { usePlugin } from "./plugin-data";
import { WhoCanUseIt } from "./who-can-use-it";

/** "6 people can use it now." or "8 people in Sales can use it now." */
function ShareLayout({ back, logo, title, subtitle, draft, setDraft, savedDraft, ownerName, onSave, saving, error }: {
  back: { href: string; label: string };
  logo: ReactNode;
  title: string;
  subtitle: string;
  draft: AccessDraft;
  setDraft: (draft: AccessDraft) => void;
  savedDraft: AccessDraft;
  ownerName: string;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}) {
  const { orgContext } = useOrgDashboard();
  if (!orgContext) return null;
  const ownerId = orgContext.currentMember.id;
  const count = accessPeopleIds(draft, orgContext, ownerId).length;
  const unchanged = sameAccess(draft, savedDraft);
  const canShareWithEveryone = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner).isAdmin;

  return (
    <ItemPage testId="share-screen">
      <ItemHeader back={back} logo={logo} title={title} description={subtitle} />
      <section className="flex flex-col gap-2.5">
        <SectionTitle title="Who can use it" />
        <WhoCanUseIt
          value={draft}
          onChange={setDraft}
          members={orgContext.members}
          teams={orgContext.teams}
          owner={{ id: ownerId, name: ownerName, isYou: true }}
          canShareWithEveryone={canShareWithEveryone}
          disabled={saving}
        />
      </section>
      {error ? <p className="text-[13px] text-red-600">{error}</p> : null}
      <StepFooter note={shareConsequence(draft, orgContext, ownerId)}>
        <LinkButton href={back.href}>Cancel</LinkButton>
        <DenButton loading={saving} disabled={unchanged} onClick={onSave}>
          {count > 0 ? `Share with ${peopleLabel(count)}` : "Save"}
        </DenButton>
      </StepFooter>
    </ItemPage>
  );
}

function useShareFlow(savedDraft: AccessDraft | null) {
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  useEffect(() => {
    if (savedDraft && draft === null) setDraft(savedDraft);
  }, [draft, savedDraft]);
  return { draft, setDraft };
}

function viewerName(org: DenOrgContext | null, fallback: string): string {
  const me = org?.members.find((member) => member.id === org.currentMember.id);
  return me?.user.name || me?.user.email || fallback;
}

/** A7: share a connector the member added. */
export function ShareConnectorScreen({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const usable = useMcpConnections("usable");
  const saveAccess = useSaveConnectionAccess();
  const connection = usable.data?.find((entry) => entry.id === connectionId) ?? null;
  const saved = connection?.access ?? null;
  const { draft, setDraft } = useShareFlow(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = { href: getLibraryConnectorRoute(orgSlug, connectionId), label: connection?.name ?? "Back" };

  if (!connection || !draft || !saved || !orgContext) {
    return (
      <ItemPage>
        <ItemHeader
          back={back}
          title={usable.isLoading ? "Loading..." : usable.error ? "It did not load" : "You can't share this"}
          description={usable.isLoading ? undefined : usable.error ? "Reload the page to try again." : "Only the person who added it can share it."}
        />
      </ItemPage>
    );
  }

  const name = connection.name;
  const subtitle = connection.authType === "oauth" && connection.credentialMode === "per_member"
    ? `Each person signs in with their own ${name} account. Nobody uses yours.`
    : `Everyone you add uses ${name} the way you set it up.`;

  async function save() {
    if (!draft || !saved || !orgContext) return;
    setSaving(true);
    setError(null);
    try {
      await saveAccess(connectionId, draft);
      const previous = saved;
      toast({
        title: `${name} is shared`,
        description: sharedToastDescription(draft, orgContext, orgContext.currentMember.id),
        action: { label: "Undo", onClick: () => saveAccess(connectionId, previous) },
      });
      router.push(getLibraryRoute(orgSlug));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Sharing did not save.");
      setSaving(false);
    }
  }

  return (
    <ShareLayout
      back={back}
      logo={<ConnectorLogo name={name} url={connection.url} size="lg" />}
      title={`Share ${name}`}
      subtitle={subtitle}
      draft={draft}
      setDraft={setDraft}
      savedDraft={saved}
      ownerName={viewerName(orgContext, "You")}
      onSave={() => void save()}
      saving={saving}
      error={error}
    />
  );
}

/** B3: share a plugin the member made. */
export function SharePluginScreen({ pluginId }: { pluginId: string }) {
  const router = useRouter();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const plugin = usePlugin(pluginId);
  const access = usePluginAccess(pluginId);
  const savePluginAccess = useSavePluginAccess();
  const saved = access.data ? draftFromPluginGrants(access.data) : null;
  const { draft, setDraft } = useShareFlow(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = { href: getLibraryPluginRoute(orgSlug, pluginId), label: plugin.data?.name ?? "Back" };

  if (!plugin.data || !draft || !saved || !access.data || !orgContext) {
    return (
      <ItemPage>
        <ItemHeader
          back={back}
          title={plugin.isLoading || access.isLoading ? "Loading..." : plugin.error || access.error ? "It did not load" : "You can't share this"}
          description={plugin.isLoading || access.isLoading ? undefined : plugin.error || access.error ? "Reload the page to try again." : "Only the person who made it can share it."}
        />
      </ItemPage>
    );
  }

  const name = plugin.data.name;
  const ownerId = orgContext.currentMember.id;

  async function save() {
    if (!draft || !orgContext || !access.data) return;
    setSaving(true);
    setError(null);
    try {
      await savePluginAccess({ pluginId, grants: access.data, next: draft, ownerId });
      toast({
        title: `${name} is shared`,
        description: sharedToastDescription(draft, orgContext, ownerId),
        action: {
          label: "Undo",
          onClick: async () => {
            const refreshed = await access.refetch();
            if (refreshed.data && saved) await savePluginAccess({ pluginId, grants: refreshed.data, next: saved, ownerId });
          },
        },
      });
      router.push(getLibraryRoute(orgSlug));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Sharing did not save.");
      setSaving(false);
    }
  }

  return (
    <ShareLayout
      back={back}
      logo={<LetterTile name={name} size="lg" />}
      title={`Share ${name}`}
      subtitle={pluginShareSubtitle(plugin.data)}
      draft={draft}
      setDraft={setDraft}
      savedDraft={saved}
      ownerName={viewerName(orgContext, "You")}
      onSave={() => void save()}
      saving={saving}
      error={error}
    />
  );
}
