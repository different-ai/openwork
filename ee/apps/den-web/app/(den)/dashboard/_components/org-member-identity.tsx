import { splitRoleString, type DenOrgMember } from "../../_lib/den-org";

function getInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}

export function OrgMemberIdentity({
  member,
  inverted = false,
}: {
  member: DenOrgMember;
  inverted?: boolean;
}) {
  const isAdmin = splitRoleString(member.role).includes("admin");
  const isInvited = !member.joinedAt;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold uppercase ${inverted ? "bg-white/15 text-white" : "bg-[#0f172a] text-white"}`}>
        {getInitials(member.user.name)}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className={`truncate text-[13px] font-medium ${inverted ? "text-white" : "text-gray-900"}`}>
            {member.user.name}
          </p>
          {isAdmin ? (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${inverted ? "bg-white/15 text-white/80" : "bg-indigo-50 text-indigo-600"}`}>
              Admin
            </span>
          ) : null}
          {isInvited ? (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${inverted ? "bg-white/15 text-white/80" : "bg-amber-50 text-amber-700"}`}>
              Invited
            </span>
          ) : null}
        </div>
        <p className={`truncate text-[12px] ${inverted ? "text-white/70" : "text-gray-400"}`}>
          {member.user.email}
        </p>
      </div>
    </div>
  );
}
