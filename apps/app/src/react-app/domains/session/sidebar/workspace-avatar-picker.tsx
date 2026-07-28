/** @jsxImportSource react */
import * as React from "react";
import { ImagePlus, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorkspaceAvatar } from "@/react-app/design-system/workspace-avatar";
import {
  WORKSPACE_AVATAR_COLORS,
  readWorkspaceAvatarImage,
} from "@/react-app/design-system/workspace-avatar-utils";
import { cn } from "@/lib/utils";
import { t } from "../../../../i18n";
import {
  useWorkspaceAvatarPreference,
  useWorkspaceAvatarStore,
} from "./workspace-avatar-store";

type WorkspaceAvatarPickerProps = {
  workspaceId: string;
  label: string;
  sizeClass?: string;
};

export function WorkspaceAvatarPicker({
  workspaceId,
  label,
  sizeClass = "size-4",
}: WorkspaceAvatarPickerProps) {
  const preference = useWorkspaceAvatarPreference(workspaceId);
  const setColor = useWorkspaceAvatarStore((state) => state.setColor);
  const setImageUrl = useWorkspaceAvatarStore((state) => state.setImageUrl);
  const clear = useWorkspaceAvatarStore((state) => state.clear);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const onPickFile = async (file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    setBusy(true);
    try {
      const imageUrl = await readWorkspaceAvatarImage(file);
      setImageUrl(workspaceId, imageUrl);
      setOpen(false);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-full leading-none outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring",
              sizeClass,
            )}
            aria-label={t("workspace_list.edit_avatar")}
            title={t("workspace_list.edit_avatar")}
            onClick={(event) => {
              event.stopPropagation();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
          >
            <WorkspaceAvatar
              workspaceId={workspaceId}
              label={label}
              sizeClass={sizeClass}
              color={preference?.color}
              imageUrl={preference?.imageUrl}
            />
          </button>
        }
      />
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        className="w-56 gap-3 p-3"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <p className="text-xs font-medium text-muted-foreground">
          {t("workspace_list.avatar_color")}
        </p>
        <div className="grid grid-cols-5 gap-2">
          {WORKSPACE_AVATAR_COLORS.map((color) => {
            const selected = preference?.color === color && !preference?.imageUrl;
            return (
              <button
                key={color}
                type="button"
                className={cn(
                  "size-7 rounded-full ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "ring-2 ring-foreground",
                )}
                style={{ backgroundColor: color }}
                aria-label={t("workspace_list.avatar_use_color")}
                aria-pressed={selected}
                onClick={() => {
                  setImageUrl(workspaceId, null);
                  setColor(workspaceId, color);
                }}
              />
            );
          })}
        </div>

        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start gap-2"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus className="size-3.5" />
            {t("workspace_list.avatar_choose_photo")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start gap-2 text-muted-foreground"
            disabled={busy || (!preference?.color && !preference?.imageUrl)}
            onClick={() => clear(workspaceId)}
          >
            <RotateCcw className="size-3.5" />
            {t("workspace_list.avatar_reset")}
          </Button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            void onPickFile(event.target.files?.[0] ?? null);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
