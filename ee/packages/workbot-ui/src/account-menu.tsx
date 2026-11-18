"use client";

import { Menu } from "@base-ui/react/menu";
import { ArrowLeftRight, LayoutDashboard, LogOut } from "lucide-react";
import { useState } from "react";
import { initials } from "./format";
import { workbotHost, type WorkbotHost } from "./host";

const avatarClass = "grid size-8 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[12px] font-semibold tracking-[0.02em] text-[var(--wb-on-ink)] transition-opacity duration-150 hover:opacity-85 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
const itemClass = "flex h-9 w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13px] leading-[18px] text-[var(--wb-text)] outline-none select-none data-[highlighted]:bg-[var(--wb-chip)] data-[disabled]:opacity-60";

/** The header avatar: a link to the dashboard, or the account menu where the host offers one. */
export function AccountAvatar({ userName }: { userName: string | null }) {
  const host = workbotHost();
  if (!host.account) {
    return <a href={host.homeHref} aria-label="Your dashboard" className={avatarClass}>{initials(userName)}</a>;
  }
  return <AccountMenu userName={userName} homeHref={host.homeHref} account={host.account} />;
}

function AccountMenu({ userName, homeHref, account }: { userName: string | null; homeHref: string; account: NonNullable<WorkbotHost["account"]> }) {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOut = () => {
    setSigningOut(true);
    setError(null);
    account.signOut().catch((failure: unknown) => {
      setSigningOut(false);
      setError(failure instanceof Error ? failure.message : "Workbot couldn't sign you out. Try again.");
    });
  };
  return (
    <Menu.Root onOpenChange={(open) => { if (open) setError(null); }}>
      <Menu.Trigger data-testid="workbot-account-menu" aria-label={`Account: ${userName ?? account.email}`} className={avatarClass}>
        {initials(userName)}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} className="z-50">
          <Menu.Popup className="workbot flex max-h-[var(--available-height)] w-[min(17rem,calc(100vw-24px))] flex-col overflow-y-auto rounded-xl bg-[var(--wb-surface)] p-1.5 text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] focus-visible:outline-none">
            <div className="min-w-0 px-2.5 pb-2 pt-1.5">
              <p className="truncate text-[13px] font-semibold leading-[18px]">{userName ?? account.email}</p>
              {userName ? <p className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">{account.email}</p> : null}
              <p data-testid="workbot-account-workspace" className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">{account.organizationName}</p>
            </div>
            <Menu.Separator className="mx-1 my-1 h-px bg-[var(--wb-hairline)]" />
            <Menu.Item className={itemClass} onClick={() => account.switchWorkspace()}>
              <ArrowLeftRight size={16} strokeWidth={1.5} aria-hidden className="text-[var(--wb-muted)]" />
              Switch workspace
            </Menu.Item>
            <Menu.LinkItem className={itemClass} href={homeHref}>
              <LayoutDashboard size={16} strokeWidth={1.5} aria-hidden className="text-[var(--wb-muted)]" />
              Your dashboard
            </Menu.LinkItem>
            <Menu.Separator className="mx-1 my-1 h-px bg-[var(--wb-hairline)]" />
            <Menu.Item data-testid="workbot-sign-out" className={itemClass} closeOnClick={false} disabled={signingOut} onClick={signOut}>
              <LogOut size={16} strokeWidth={1.5} aria-hidden className="text-[var(--wb-muted)]" />
              {signingOut ? "Signing out…" : "Sign out"}
            </Menu.Item>
            {error ? <p role="alert" className="px-2.5 pb-1.5 pt-1 text-[12px] leading-4 text-[var(--wb-danger)]">{error}</p> : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
