/** @jsxImportSource react */

import {
  resolveWorkspaceAvatarColor,
  workspaceAvatarColor,
  workspaceAvatarInitials,
} from "./workspace-avatar-utils";

export type WorkspaceAvatarProps = {
  workspaceId: string;
  label: string;
  imageUrl?: string | null;
  color?: string | null;
  sizeClass?: string;
};

export { workspaceAvatarColor, workspaceAvatarInitials, resolveWorkspaceAvatarColor };

export function WorkspaceAvatar({
  workspaceId,
  label,
  imageUrl,
  color,
  sizeClass = "size-4",
}: WorkspaceAvatarProps) {
  const trimmedUrl = imageUrl?.trim() ?? "";
  if (trimmedUrl) {
    return (
      <img
        src={trimmedUrl}
        alt=""
        className={`${sizeClass} shrink-0 rounded-full object-cover`}
        draggable={false}
        data-workspace-avatar=""
      />
    );
  }

  return (
    <span
      className={`${sizeClass} inline-block shrink-0 rounded-full leading-none`}
      style={{ backgroundColor: resolveWorkspaceAvatarColor(workspaceId, color) }}
      role="presentation"
      aria-hidden="true"
      data-workspace-avatar=""
      title={label}
    />
  );
}
