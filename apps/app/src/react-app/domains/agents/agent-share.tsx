import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersonalAgentDetail, PersonalAgentRole, PersonalAgentShareRole } from "@openwork/types/den/personal-agents";
import { Plus, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";

import type { AgentsRuntime } from "./agents-runtime";
import { agentListKey, agentsQueryRoot } from "./use-agents";

export function canChangeShare(actor: PersonalAgentRole, current: PersonalAgentRole | null, next: PersonalAgentShareRole | null): boolean {
  if (current === "owner") return false;
  if (actor === "owner") return true;
  return actor === "manager" && current !== "manager" && next !== "manager";
}

type ShareChange = { memberId: string; role: PersonalAgentShareRole | null };

export function AgentShare({ agent, runtime }: { agent: PersonalAgentDetail; runtime: AgentsRuntime }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const { client, organizationId } = runtime;
  const queryClient = useQueryClient();
  const key = agentListKey(runtime);
  const directory = useQuery({
    queryKey: [...agentsQueryRoot(runtime), "directory"],
    queryFn: () => client.getLibraryOrgDirectory(organizationId),
    enabled: open && adding,
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: ({ memberId, role }: ShareChange) => {
      const current = memberId === agent.agent.ownerMemberId ? "owner" : agent.sharedWith.find((share) => share.memberId === memberId)?.role ?? null;
      if (!canChangeShare(agent.role, current, role)) return Promise.reject(new Error(t("agents.share_owner_only")));
      return role ? client.setPersonalAgentShare(organizationId, agent.agent.id, memberId, role)
        : client.removePersonalAgentShare(organizationId, agent.agent.id, memberId);
    },
    onSuccess: (shares) => {
      queryClient.setQueryData<PersonalAgentDetail[]>(key, (items) => items?.map((item) => item.agent.id === agent.agent.id
        ? { ...item, owner: shares.owner, sharedWith: shares.items } : item));
      return queryClient.invalidateQueries({ queryKey: key });
    },
    onError: () => toast.error(t("agents.share_failed")),
  });
  const people = (directory.data?.members ?? []).filter((person) => person.id !== agent.agent.ownerMemberId
    && person.name !== person.id && person.name !== person.email && !person.name.includes("@")
    && !agent.sharedWith.some((share) => share.memberId === person.id));
  const audience = [
    ...(agent.audience?.organization ? [{ key: "organization", name: t("agents.share_organization") }] : []),
    ...(agent.audience?.teams ?? []).map((team) => ({ key: `team:${team.teamId}`, name: team.name })),
  ];
  const ownerName = agent.owner?.name || t("agents.share_owner");

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setAdding(false); }}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <UserPlus aria-hidden="true" />{t("agents.share_button")}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 gap-3 rounded-2xl">
        <PopoverHeader>
          <PopoverTitle>{t("agents.share_title")}</PopoverTitle>
          <PopoverDescription className="text-xs">{t("agents.share_accounts", { name: agent.agent.name })}</PopoverDescription>
          <p data-agent-share-results-note className="text-xs text-muted-foreground">{t("agents.share_results_note")}</p>
        </PopoverHeader>
        <div className="divide-y divide-border">
          {audience.map(({ key, name }) => (
            <div key={key} data-agent-share-audience={key} className="flex min-h-11 items-center justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <p className="truncate font-medium">{name}</p>
                <p className="text-xs text-muted-foreground">{t("agents.share_managed_by_admin")}</p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{t("agents.share_collaborator")}</span>
            </div>
          ))}
          <div className="flex min-h-10 items-center justify-between gap-2">
            <span className="truncate font-medium">{agent.role === "owner" ? t("agents.share_owner_you", { name: ownerName }) : ownerName}</span>
            <span className="text-xs text-muted-foreground">{t("agents.share_owner")}</span>
          </div>
          {agent.sharedWith.map((person) => {
            const locked = !canChangeShare(agent.role, person.role, null);
            const managerLocked = !canChangeShare(agent.role, person.role, "manager");
            const description = person.role === "manager" ? t("agents.share_manager_hint") : t("agents.share_collaborator_hint");
            return (
              <div key={person.memberId} className="py-1.5">
                <div className="flex min-h-8 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{person.name}</span>
                  <Select value={person.role} disabled={locked || save.isPending} onValueChange={(role) => {
                    if ((role === "manager" || role === "collaborator") && role !== person.role) save.mutate({ memberId: person.memberId, role });
                  }}>
                    <SelectTrigger aria-label={t("agents.share_role_for", { name: person.name })} size="sm">
                      <SelectValue>{person.role === "manager" ? t("agents.share_manager") : t("agents.share_collaborator")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent className="min-w-60">
                      <SelectItem value="manager" disabled={managerLocked}>
                        <span className="flex flex-col"><span>{t("agents.share_manager")}</span><span className="text-xs font-normal">{t("agents.share_manager_hint")}</span></span>
                      </SelectItem>
                      <SelectItem value="collaborator">
                        <span className="flex flex-col"><span>{t("agents.share_collaborator")}</span><span className="text-xs font-normal">{t("agents.share_collaborator_hint")}</span></span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="sm" aria-label={t("agents.share_remove_person", { name: person.name })} disabled={locked || save.isPending} onClick={() => save.mutate({ memberId: person.memberId, role: null })}>
                    {t("agents.share_remove")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{locked ? t("agents.share_owner_only") : description}</p>
              </div>
            );
          })}
        </div>
        {agent.role === "manager" && <p className="text-xs text-muted-foreground">{t("agents.share_manager_limit")}</p>}
        <Popover open={adding} onOpenChange={setAdding}>
          <PopoverTrigger render={<Button variant="outline" size="sm" className="self-start" disabled={save.isPending} />}>
            <Plus aria-hidden="true" />{t("agents.share_add")}
          </PopoverTrigger>
          <PopoverContent align="start" className="gap-0 rounded-2xl p-1.5">
            <PopoverTitle className="sr-only">{t("agents.share_add")}</PopoverTitle>
            {directory.isError ? <p className="p-2 text-sm text-muted-foreground">{t("agents.share_directory_failed")}</p> : (
              <Command items={people} itemToStringValue={(person) => typeof person === "object" && person !== null && "name" in person && typeof person.name === "string" ? person.name : ""}>
                <CommandInput aria-label={t("agents.share_search")} placeholder={t("agents.share_search")} />
                {directory.isPending ? <div aria-hidden="true" className="m-2 h-8 motion-safe:animate-pulse rounded-md bg-muted" /> : <CommandEmpty>{t("agents.share_empty")}</CommandEmpty>}
                <CommandList className="max-h-52">
                  {(person: (typeof people)[number]) => (
                    <CommandItem key={person.id} value={person} onClick={() => {
                      setAdding(false);
                      save.mutate({ memberId: person.id, role: "collaborator" });
                    }}><span className="truncate">{person.name}</span></CommandItem>
                  )}
                </CommandList>
              </Command>
            )}
          </PopoverContent>
        </Popover>
      </PopoverContent>
    </Popover>
  );
}
