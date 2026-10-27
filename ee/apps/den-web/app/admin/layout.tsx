import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AdminShell } from "../../components/admin/admin-shell";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  // Only a UI hint. Each admin data endpoint verifies the session and allowlist.
  const hasSessionCookie = cookieStore.getAll().some(({ name, value }) =>
    Boolean(value) && /^(?:__Secure-)?(?:openwork-den(?:-[a-z0-9]{1,32})?|better-auth)\.session_token(?:\.\d+)?$/.test(name),
  );
  return <AdminShell hasSessionCookie={hasSessionCookie}>{children}</AdminShell>;
}
