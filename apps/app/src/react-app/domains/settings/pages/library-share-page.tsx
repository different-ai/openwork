/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { Globe, Info, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import type { DenLibraryOrgDirectory } from "../../../../app/lib/den-library";
import { t } from "../../../../i18n";
import type { ExtensionTaxonomy } from "../extension-taxonomy";
import {
  isLibraryAudienceShared,
  libraryAudienceName,
  libraryAudiencePeopleCount,
  type LibraryAudience,
} from "../library-sharing";
import type { LibraryShareTarget } from "../use-library-cloud";
import { LibraryPage } from "./library-page";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "?";
}

function AudienceRow(props: { avatar: ReactNode; title: string; hint: string; trailing: ReactNode; testId?: string }) {
  return (
    <div data-share-row={props.testId ?? props.title} className="flex items-center gap-3 border-b border-dls-border/60 py-3 last:border-b-0">
      {props.avatar}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-dls-text">{props.title}</p>
        <p className="truncate text-xs text-dls-secondary">{props.hint}</p>
      </div>
      {props.trailing}
    </div>
  );
}

function Avatar(props: { name: string; tone: "owner" | "team" | "person" }) {
  const tone = props.tone === "owner"
    ? "bg-foreground text-background"
    : props.tone === "team"
      ? "bg-violet-3 text-violet-11"
      : "bg-dls-hover text-dls-secondary";
  return (
    <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${tone}`}>
      {initials(props.name)}
    </span>
  );
}

function whatTheyGet(taxonomy: ExtensionTaxonomy) {
  if (taxonomy === "connection" || taxonomy === "mcp") return t("extensions.share_gets_connector");
  if (taxonomy === "plugin") return t("extensions.share_gets_plugin");
  return t("extensions.share_gets_skill");
}

export function kindLabel(taxonomy: ExtensionTaxonomy) {
  if (taxonomy === "connection" || taxonomy === "mcp") return t("extensions.kind_connector");
  if (taxonomy === "plugin") return t("extensions.kind_plugin");
  return t("extensions.kind_skill");
}

/**
 * Who can use something the member made. Changes stay on the page until the
 * member confirms; picking nobody turns the button into Stop sharing.
 */
export function LibrarySharePage(props: {
  name: string;
  description: string | null;
  taxonomy: ExtensionTaxonomy;
  icon: ReactNode;
  directory: DenLibraryOrgDirectory | null;
  initialAudience: LibraryAudience;
  canShareOrgWide: boolean;
  onCancel: () => void;
  onSave: (targets: LibraryShareTarget[], audience: LibraryAudience) => Promise<void>;
}) {
  const [audience, setAudience] = useState<LibraryAudience>(props.initialAudience);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const directory = props.directory;
  const owner = directory?.members.find((member) => member.id === directory.currentMemberId) ?? null;
  const wasShared = isLibraryAudienceShared(props.initialAudience);
  const shared = isLibraryAudienceShared(audience);
  const unchanged = JSON.stringify(targetsFor(audience)) === JSON.stringify(targetsFor(props.initialAudience));
  const audienceName = libraryAudienceName(audience);
  const teamsLeft = (directory?.teams ?? []).filter((team) => !audience.teams.some((entry) => entry.id === team.id));
  const peopleLeft = (directory?.members ?? []).filter((member) =>
    member.id !== directory?.currentMemberId && !audience.people.some((entry) => entry.id === member.id));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onSave(targetsFor(audience), audience);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.trim() ? cause.message : t("common.something_went_wrong"));
      setBusy(false);
    }
  };

  const primaryLabel = shared
    ? t("extensions.share_with", { audience: audienceName })
    : t("extensions.share_stop");

  return (
    <LibraryPage
      title={props.name}
      subtitle={[kindLabel(props.taxonomy), props.description?.trim()].filter(Boolean).join(" · ")}
      icon={props.icon}
      crumbs={[{ label: props.name }]}
      testId="library-share-page"
      backDisabled={busy}
      onBack={props.onCancel}
      footerNote={shared
        ? t("extensions.share_footer_shared", { audience: audienceName })
        : wasShared
          ? t("extensions.share_footer_stop")
          : t("extensions.share_footer_just_me")}
      actions={(
        <>
          <Button variant="outline" disabled={busy} onClick={props.onCancel}>{t("common.cancel")}</Button>
          <Button disabled={busy || unchanged || (!shared && !wasShared)} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {primaryLabel}
          </Button>
        </>
      )}
    >
      <section aria-labelledby="library-share-who" className="flex flex-col">
        <h2 id="library-share-who" className="mb-1 text-[15px] font-semibold text-dls-text">{t("extensions.share_who_can_use")}</h2>
        {props.canShareOrgWide ? (
          <AudienceRow
            testId="everyone"
            avatar={(
              <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dls-border text-dls-secondary">
                <Globe size={15} />
              </span>
            )}
            title={t("extensions.share_everyone_title")}
            hint={audience.orgWide ? t("extensions.share_everyone_on") : t("extensions.share_everyone_off")}
            trailing={(
              <Switch
                aria-label={t("extensions.share_everyone_title")}
                checked={audience.orgWide}
                disabled={busy}
                onCheckedChange={(checked) => setAudience((current) => ({ ...current, orgWide: checked }))}
              />
            )}
          />
        ) : null}
        <AudienceRow
          testId="owner"
          avatar={<Avatar name={owner?.name ?? "?"} tone="owner" />}
          title={t("extensions.share_owner_title", { name: owner?.name ?? t("extensions.share_you") })}
          hint={t("extensions.share_owner_hint")}
          trailing={<span className="text-xs text-dls-secondary">{t("extensions.share_owner_role")}</span>}
        />
        {audience.teams.map((team) => (
          <AudienceRow
            key={team.id}
            avatar={<Avatar name={team.name} tone="team" />}
            title={team.name}
            hint={t("extensions.share_team_hint", { count: String(team.peopleCount), team: team.name })}
            trailing={(
              <Button
                variant="ghost"
                size="sm"
                className="text-red-11 hover:text-red-11"
                disabled={busy}
                aria-label={t("extensions.share_remove", { name: team.name })}
                onClick={() => setAudience((current) => ({ ...current, teams: current.teams.filter((entry) => entry.id !== team.id) }))}
              >
                {t("extensions.share_remove_short")}
              </Button>
            )}
          />
        ))}
        {audience.people.map((person) => (
          <AudienceRow
            key={person.id}
            avatar={<Avatar name={person.name} tone="person" />}
            title={person.name}
            hint={t("extensions.share_person_hint")}
            trailing={(
              <Button
                variant="ghost"
                size="sm"
                className="text-red-11 hover:text-red-11"
                disabled={busy}
                aria-label={t("extensions.share_remove", { name: person.name })}
                onClick={() => setAudience((current) => ({ ...current, people: current.people.filter((entry) => entry.id !== person.id) }))}
              >
                {t("extensions.share_remove_short")}
              </Button>
            )}
          />
        ))}
        <div className="mt-3 flex flex-wrap gap-2">
          <AddAudienceMenu
            label={t("extensions.share_add_person")}
            empty={t("extensions.share_add_person_empty")}
            disabled={busy}
            options={peopleLeft.map((member) => ({ id: member.id, label: member.name }))}
            onPick={(id) => {
              const member = peopleLeft.find((entry) => entry.id === id);
              if (!member) return;
              setAudience((current) => ({ ...current, people: [...current.people, { id: member.id, name: member.name, grantId: null }] }));
            }}
          />
          <AddAudienceMenu
            label={t("extensions.share_add_team")}
            empty={t("extensions.share_add_team_empty")}
            disabled={busy}
            options={teamsLeft.map((team) => ({ id: team.id, label: team.name }))}
            onPick={(id) => {
              const team = teamsLeft.find((entry) => entry.id === id);
              if (!team) return;
              setAudience((current) => ({
                ...current,
                teams: [...current.teams, { id: team.id, name: team.name, peopleCount: team.memberIds.length, grantId: null }],
              }));
            }}
          />
        </div>
      </section>
      <p className="flex items-start gap-2 rounded-lg bg-dls-hover px-3.5 py-3 text-[13px] text-dls-secondary">
        <Info size={15} className="mt-0.5 shrink-0" />
        <span>
          {whatTheyGet(props.taxonomy)}
          {shared && directory ? ` ${t("extensions.share_people_count", { count: String(libraryAudiencePeopleCount(audience, directory)) })}` : ""}
        </span>
      </p>
      {error ? <p role="alert" className="text-[13px] text-red-11">{error}</p> : null}
    </LibraryPage>
  );
}

function AddAudienceMenu(props: {
  label: string;
  empty: string;
  disabled: boolean;
  options: Array<{ id: string; label: string }>;
  onPick: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="rounded-full" disabled={props.disabled} />}
      >
        <Plus size={13} />
        {props.label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuGroup>
          {props.options.length === 0 ? (
            <DropdownMenuItem disabled>{props.empty}</DropdownMenuItem>
          ) : props.options.map((option) => (
            <DropdownMenuItem key={option.id} onClick={() => props.onPick(option.id)}>{option.label}</DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function targetsFor(audience: LibraryAudience): LibraryShareTarget[] {
  const targets: LibraryShareTarget[] = [];
  if (audience.orgWide) targets.push({ kind: "everyone" });
  for (const team of audience.teams) targets.push({ kind: "team", id: team.id });
  for (const person of audience.people) targets.push({ kind: "person", id: person.id });
  return targets;
}
