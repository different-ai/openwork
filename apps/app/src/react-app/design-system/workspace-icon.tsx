/** @jsxImportSource react */
import { MarbleAvatar } from "./marble-avatar";

export type WorkspaceIconProps = {
  workspaceId: string;
  /** CSS size class, e.g. "size-4", "size-5.5". Defaults to "size-4". */
  sizeClass?: string;
};

export function WorkspaceIcon({ workspaceId, sizeClass = "size-4" }: WorkspaceIconProps) {
  return (
    <MarbleAvatar seed={workspaceId} className={`${sizeClass} shrink-0 rounded-full`} />
  );
}
