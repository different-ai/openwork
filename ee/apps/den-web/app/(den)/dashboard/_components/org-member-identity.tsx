import { getOrgAccessFlags, type DenOrgMember } from "../../_lib/den-org";
import { BUILT_IN_ROLES } from "../../_lib/role-catalog";

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
  compact = false,
}: {
  member: DenOrgMember;
  inverted?: boolean;
  /** Role and invitation state already have their own columns in the members list. */
  compact?: boolean;
}) {
  const access = getOrgAccessFlags(member.role, member.isOwner);
  const roleBadge = access.isOwner
    ? BUILT_IN_ROLES.owner.label
    : access.isSuperAdmin
      ? BUILT_IN_ROLES["super-admin"].label
      : access.canonicalRole === "admin"
      ? BUILT_IN_ROLES.admin.label
      : null;
  const isInvited = !member.joinedAt;
  const name = compact && (isInvited || !member.user.name || member.user.name === member.user.email)
    ? member.user.email
    : member.user.name || member.user.email;

  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="org-member-identity">
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold uppercase ${inverted ? "bg-white/15 text-white" : "bg-[#0f172a] text-white"}`}>
        {getInitials(member.user.name || member.user.email)}
      </div>
      <div className="min-w-0">
        <div className={`flex min-w-0 items-center gap-1.5 ${compact ? "" : "flex-wrap"}`}>
          <p title={name} className={`${compact ? "text-[14px]" : "text-[13px]"} truncate font-medium ${inverted ? "text-white" : "text-gray-900"}`}>
            {name}
          </p>
          {!compact && roleBadge ? (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${inverted ? "bg-white/15 text-white/80" : "bg-indigo-50 text-indigo-600"}`}>
              {roleBadge}
            </span>
          ) : null}
          {!compact && isInvited ? (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${inverted ? "bg-white/15 text-white/80" : "bg-amber-50 text-amber-700"}`}>
              Invited
            </span>
          ) : null}
        </div>
        {!compact || name !== member.user.email ? <p title={member.user.email} className={`${compact ? "text-[13px]" : "text-[12px]"} truncate ${inverted ? "text-white/70" : "text-gray-500"}`}>
          {member.user.email}
        </p> : null}
      </div>
    </div>
  );
}
