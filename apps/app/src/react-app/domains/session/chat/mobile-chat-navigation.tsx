/** @jsxImportSource react */
import { ArrowLeft, Cloud, FileText, MoreHorizontal, TextSearch } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "../../../../i18n";

export function MobileChatNavigation() {
  const { openMobile } = useSidebar();
  return (
    <SidebarTrigger
      data-mobile-chat-navigation
      aria-label="Open sidebar"
      aria-expanded={openMobile}
      className="ms-[max(0.5rem,env(safe-area-inset-left))] mt-[env(safe-area-inset-top)] size-11 shrink-0 self-start motion-reduce:transition-none"
    />
  );
}

export type MobileChatActionsProps = {
  onFind?: () => void;
  onFiles: () => void;
  fileCount: number;
  onSignIn?: () => void;
  onParent?: () => void;
};

/** The former chat-header overflow lives inside the existing mobile sidebar. */
export function MobileChatActions(props: MobileChatActionsProps) {
  const { setOpenMobile } = useSidebar();
  const select = (action: () => void) => () => {
    setOpenMobile(false);
    action();
  };
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger render={<SidebarMenuButton />}>
          <MoreHorizontal />
          <span>Chat actions</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuGroup>
            {props.onParent ? <DropdownMenuItem onClick={select(props.onParent)}><ArrowLeft />Back to parent chat</DropdownMenuItem> : null}
            {props.onFind ? <DropdownMenuItem onClick={select(props.onFind)}><TextSearch />Find in conversation</DropdownMenuItem> : null}
            <DropdownMenuItem onClick={select(props.onFiles)}><FileText />Files{props.fileCount > 0 ? ` (${props.fileCount})` : ""}</DropdownMenuItem>
            {props.onSignIn ? <DropdownMenuItem onClick={select(props.onSignIn)}><Cloud />{t("den.signin_button")}</DropdownMenuItem> : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
