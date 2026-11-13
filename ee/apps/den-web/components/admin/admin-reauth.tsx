"use client";

import { useEffect, useRef, useState } from "react";
import { ReauthDialog } from "../../app/(den)/_components/reauth-dialog";
import { type AuthUser, getUser, requestJson } from "../../app/(den)/_lib/den-flow";
import { setAdminReauthPrompt } from "./admin-request";

/**
 * The confirm-your-identity dialog for platform-admin changes. Den refuses a
 * change from a sign-in that is no longer recent; the request helpers ask
 * here, and send the change again once the admin has confirmed.
 */
export function AdminReauth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [open, setOpen] = useState(false);
  const waiting = useRef<((confirmed: boolean) => void)[]>([]);

  function settle(confirmed: boolean) {
    const pending = waiting.current;
    waiting.current = [];
    setOpen(false);
    for (const resolve of pending) resolve(confirmed);
  }

  useEffect(() => {
    setAdminReauthPrompt(() => new Promise<boolean>((resolve) => {
      waiting.current.push(resolve);
      setOpen(true);
    }));
    return () => {
      setAdminReauthPrompt(null);
      settle(false);
    };
  }, []);

  useEffect(() => {
    if (!open || user) return;
    let active = true;
    void requestJson("/v1/me", { method: "GET" }, 12_000).then(({ response, payload }) => {
      if (!active) return;
      const current = response.ok ? getUser(payload) : null;
      if (current) setUser(current);
      else settle(false);
    }).catch(() => {
      if (active) settle(false);
    });
    return () => { active = false; };
  }, [open, user]);

  return (
    <ReauthDialog
      open={open && user !== null}
      user={user}
      orgContext={null}
      onCancel={() => settle(false)}
      onVerified={async () => settle(true)}
      title="Confirm your identity to make admin changes"
      description="Your change will finish automatically after you confirm."
    />
  );
}
