"use client";

import { Building2, Check, Link2, ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { AccessRow, AddPicker, Avatar, IconTile, RemoveButton } from "../../(den)/dashboard/_components/access-rows";
import { type AccessDraft, peopleLabel, sameAccess } from "../../(den)/dashboard/_components/access-summary";
import { ConnectorLogo } from "../../(den)/dashboard/_components/item-logo";
import { AppButton, AppSwitch, accessWord } from "./app-parts";
import {
  type Access,
  type Agent,
  type Role,
  CONNECTORS,
  MEMBER,
  PEOPLE,
  ROLE_LABEL,
  ROLE_LINE,
  TEAM_ROLE_LINE,
  TEAMS,
  isShared,
  keepManagers,
  personName,
  roleOf,
  routinesLine,
  sharedPeople,
  sharedWithMe,
} from "./model";
import { Dialog, LockNote } from "./parts";

// ---------------------------------------------------------------------------
// Who has access. The owner picks people and teams, and gives each a role:
// a collaborator uses the agent, a manager can also change it.
// ---------------------------------------------------------------------------

type GivenRole = Exclude<Role, "owner">;

// One agent, used by several people: what that means for the owner and for them.
export function shareTerms(agent: Agent): { label: string; value: string }[] {
  return [
    { label: "They get", value: "The same agent. They can ask it things and turn on its routines for themselves." },
    { label: "It works with", value: "Each person's own accounts and their own Slack messages. Never yours." },
    { label: "They see", value: "Its instructions, routines and tools. Never your runs or your messages." },
    { label: "They can change", value: "A collaborator changes nothing, and can make a copy. A manager can change what it does. Only you can share it or remove it." },
    { label: "Who pays", value: agent.paidBy === "org" ? "The org's agent budget, for everyone's use." : "Each person's use counts toward their own limit." },
  ];
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function RoleSelect({ id, name, role, onChange }: { id: string; name: string; role: GivenRole; onChange: (role: GivenRole) => void }) {
  return (
    <select
      aria-label={`What ${name} can do`}
      value={role}
      onChange={(event) => onChange(event.target.value === "manager" ? "manager" : "collaborator")}
      data-testid={`share-role-${id}`}
      className="h-8 shrink-0 rounded-lg border border-[#e0e1e6] bg-white px-2 text-[13px] text-[#1c2024] outline-none transition-colors hover:bg-[#f0f0f3] focus-visible:border-[#1c2024]"
    >
      <option value="collaborator">{ROLE_LABEL.collaborator}</option>
      <option value="manager">{ROLE_LABEL.manager}</option>
    </select>
  );
}

export function ShareDialog({ agent, access, onShare, onClose }: {
  agent: Agent;
  access: Access;
  onShare: (share: AccessDraft, managers: string[]) => void;
  onClose: () => void;
}) {
  const [share, setShare] = useState<AccessDraft>(agent.share);
  const [managers, setManagers] = useState<string[]>(agent.managers);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const wasShared = isShared(agent.share, agent.owner);
  const count = sharedPeople(share, agent.owner).length;
  const kept = keepManagers(managers, share);
  const unchanged = sameAccess(share, agent.share) && sameList(kept, agent.managers);
  const canAdd = access.sharing;
  const teams = TEAMS.filter((team) => share.teamIds.includes(team.id));
  const people = PEOPLE.filter((person) => share.memberIds.includes(person.id) && person.id !== agent.owner);
  const roleFor = (id: string): GivenRole => managers.includes(id) ? "manager" : "collaborator";
  const setRole = (id: string, role: GivenRole) => setManagers(role === "manager" ? [...managers.filter((entry) => entry !== id), id] : managers.filter((entry) => entry !== id));
  const save = () => {
    onShare(share, kept);
    onClose();
  };
  const saveLabel = share.orgWide
    ? "Share with everyone"
    : count > 0 ? `Share with ${peopleLabel(count)}` : wasShared ? "Stop sharing" : "Share";

  return (
    <Dialog
      title="Who has access"
      description={`${agent.name} works with each person's own accounts. Nobody sees anyone else's runs.`}
      onClose={onClose}
      testId="share-dialog"
      footer={(
        <>
          <span className="mr-auto">
            <AppButton variant="quiet" icon={copied ? Check : Link2} onClick={() => setCopied(true)} testId="share-copy-link">{copied ? "Link copied" : "Copy link"}</AppButton>
          </span>
          <AppButton variant="quiet" onClick={onClose} testId="share-cancel">Cancel</AppButton>
          <AppButton disabled={unchanged} onClick={save} testId="share-save">{saveLabel}</AppButton>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col divide-y divide-[#f3f4f6]">
          <AccessRow
            lead={<Avatar name={personName(agent.owner)} owner />}
            title={`${personName(agent.owner)} (you)`}
            description={ROLE_LINE.owner}
            trailing={<span className="shrink-0 text-[13px] text-[#60646c]">{ROLE_LABEL.owner}</span>}
            testId="share-row-owner"
          />
          <AccessRow
            lead={<IconTile icon={Building2} />}
            title="Everyone in Sample org"
            description={share.orgWide ? `All ${peopleLabel(PEOPLE.length - 1)} can add it, as collaborators` : "Anyone in the organization can find it and add it"}
            trailing={(
              <AppSwitch
                checked={share.orgWide}
                onChange={(orgWide) => { if (canAdd || !orgWide) setShare({ ...share, orgWide }); }}
                label="Share with everyone in Sample org"
                testId="share-everyone"
              />
            )}
            testId="share-row-everyone"
          />
          {teams.map((team) => (
            <AccessRow
              key={team.id}
              lead={<IconTile icon={Users} />}
              title={team.name}
              description={`${peopleLabel(team.memberIds.filter((id) => id !== agent.owner).length)} · ${TEAM_ROLE_LINE[roleFor(team.id)]}`}
              trailing={(
                <span className="flex shrink-0 items-center gap-1">
                  <RoleSelect id={team.id} name={team.name} role={roleFor(team.id)} onChange={(role) => setRole(team.id, role)} />
                  <RemoveButton label={`Remove ${team.name}`} onClick={() => setShare({ ...share, teamIds: share.teamIds.filter((id) => id !== team.id) })} />
                </span>
              )}
              testId={`share-row-${team.id}`}
            />
          ))}
          {people.map((person) => (
            <AccessRow
              key={person.id}
              lead={<Avatar name={person.name} />}
              title={person.name}
              description={ROLE_LINE[roleFor(person.id)]}
              trailing={(
                <span className="flex shrink-0 items-center gap-1">
                  <RoleSelect id={person.id} name={person.name} role={roleFor(person.id)} onChange={(role) => setRole(person.id, role)} />
                  <RemoveButton label={`Remove ${person.name}`} onClick={() => setShare({ ...share, memberIds: share.memberIds.filter((id) => id !== person.id) })} />
                </span>
              )}
              testId={`share-row-${person.id}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AddPicker
            kind="person"
            disabled={!canAdd}
            options={PEOPLE.filter((person) => person.id !== agent.owner && !share.memberIds.includes(person.id)).map((person) => ({ id: person.id, name: person.name, detail: person.email }))}
            onAdd={(ids) => setShare({ ...share, memberIds: [...share.memberIds, ...ids] })}
          />
          <AddPicker
            kind="team"
            disabled={!canAdd}
            options={TEAMS.filter((team) => !share.teamIds.includes(team.id)).map((team) => ({ id: team.id, name: team.name, detail: peopleLabel(team.memberIds.length) }))}
            onAdd={(ids) => setShare({ ...share, teamIds: [...share.teamIds, ...ids] })}
          />
        </div>
        {canAdd ? null : <LockNote>Your admin turned off sharing agents. You can remove people, and add nobody.</LockNote>}
        <details className="group border-t border-[#f3f4f6] pt-2" data-testid="share-terms">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg py-1 text-[13px] font-medium text-[#60646c] transition-colors hover:text-[#1c2024] [&::-webkit-details-marker]:hidden">
            <span className="transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" aria-hidden>›</span>
            What sharing does
          </summary>
          <div className="flex flex-col divide-y divide-[#f3f4f6] pt-1">
            {shareTerms(agent).map((term) => (
              <div key={term.label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 py-2">
                <span className="text-[13px] font-medium leading-5 text-[#1c2024]">{term.label}</span>
                <span className="text-[13px] leading-5 text-[#60646c]">{term.value}</span>
              </div>
            ))}
          </div>
        </details>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Browse: the agents teammates shared with you. Adding one puts it in your
// sidebar. It still does nothing for you until you ask it or turn it on.
// ---------------------------------------------------------------------------

export function BrowseDialog({ agents, access, onAdd, onOpen, onClose }: {
  agents: Agent[];
  access: Access;
  onAdd: (agentId: string) => void;
  onOpen: (agentId: string) => void;
  onClose: () => void;
}) {
  const shared = sharedWithMe(agents, access);
  return (
    <Dialog
      title="Shared agents"
      description="Agents your teammates shared with you. Each one works with your own accounts, on your own budget."
      onClose={onClose}
      testId="browse-dialog"
      wide
    >
      {!access.sharing ? (
        <LockNote>Your admin turned off sharing agents.</LockNote>
      ) : shared.length === 0 ? (
        <p className="py-6 text-center text-[13px] leading-5 text-[#60646c]" data-testid="browse-empty">Nobody has shared an agent with you yet.</p>
      ) : (
        <div className="flex flex-col divide-y divide-[#f3f4f6]">
          {shared.map((agent) => {
            const role = roleOf(agent) ?? "collaborator";
            const uses = CONNECTORS.filter((connector) => agent.tools[connector.id].length > 0);
            return (
              <article key={agent.id} className="flex items-start justify-between gap-4 py-3" data-testid={`browse-agent-${agent.id}`} data-added={agent.added ? "true" : "false"}>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h3 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px] font-medium leading-5 text-[#1c2024]">
                    <span className="truncate">{agent.name}</span>
                    {agent.approved ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-normal text-[#60646c]" data-testid="browse-approved">
                        <ShieldCheck className="size-3.5" aria-hidden />
                        Approved by your admin
                      </span>
                    ) : null}
                  </h3>
                  <p className="text-[12px] leading-4 text-[#8b8d98]">{`From ${personName(agent.owner)} · You are a ${ROLE_LABEL[role].toLowerCase()} · ${routinesLine(agent)}`}</p>
                  <p className="line-clamp-2 text-[13px] leading-5 text-[#60646c]">{agent.instructions}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                    {uses.length === 0 ? <span className="text-[12px] text-[#8b8d98]">Uses no apps</span> : null}
                    {uses.map((connector) => (
                      <span key={connector.id} className="inline-flex items-center gap-1.5 text-[12px] text-[#60646c]">
                        <ConnectorLogo name={connector.name} url={connector.url} size="xs" />
                        {accessWord(connector, agent.tools[connector.id])}
                      </span>
                    ))}
                  </div>
                </div>
                {agent.added ? (
                  <AppButton variant="quiet" onClick={() => onOpen(agent.id)} testId={`browse-open-${agent.id}`}>Added · Open</AppButton>
                ) : (
                  <AppButton variant="secondary" onClick={() => onAdd(agent.id)} testId={`browse-add-${agent.id}`}>Add</AppButton>
                )}
              </article>
            );
          })}
        </div>
      )}
      {access.sharing && shared.length > 0 ? (
        <p className="border-t border-[#f3f4f6] pt-3 text-[12px] leading-4 text-[#8b8d98]">
          {`Adding one puts it in your list, ${MEMBER.name.split(" ")[0]}. It does nothing for you until you ask it or turn on its routines.`}
        </p>
      ) : null}
    </Dialog>
  );
}
