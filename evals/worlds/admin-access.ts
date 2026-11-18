import { reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

export async function adminAccessWorld(seed: Seed) {
  const den = await seed.den({ web: true, org: {
    name: "Admin access workspace",
    admin: { name: "Platform administrator" },
    members: { member: { name: "Organization member" } },
  } });
  const viewport = { width: 1280, height: 900 };
  const anonymous = await seed.web({ den, startPath: "/admin", headless: true, viewport });
  const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/admin/opportunities", headless: true, viewport });
  const expired = await seed.web({ den, signedInAs: { ...den.admin, token: "expired-session-fixture-not-a-real-token" }, startPath: "/admin/organizations", headless: true, viewport });
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/users", headless: true, viewport });

  // A web-host cookie is a separate sign-in path from localStorage bearer auth.
  const cookieAdmin = await seed.web({ den, startPath: "/admin/features", headless: true, viewport });
  const session = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: den.ref.webUrl },
    body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  if (!session.ok) throw new Error(`Cookie sign-in failed (${session.status}).`);
  const cookie = session.headers.getSetCookie().find(value => /session_token=/.test(value))?.split(";")[0];
  if (!cookie) throw new Error("Cookie sign-in did not return a session cookie.");
  const separator = cookie.indexOf("=");
  await cookieAdmin.client.send("Network.setCookie", { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: den.ref.webUrl, httpOnly: true });
  await reload(cookieAdmin);
  return { den, anonymous, member, expired, admin, cookieAdmin, url: (path: string) => new URL(path, den.ref.webUrl).toString() };
}
