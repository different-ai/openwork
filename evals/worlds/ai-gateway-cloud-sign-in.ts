import type { Place, Seed } from "@openwork/env";
import { aiGatewayAdmin } from "./ai-gateway-admin.ts";

/**
 * The AI Gateway admin world with AWS and Microsoft sign-in still off for the
 * organization (the gatewayCloudSignIn feature), so the journey can show the
 * locked state before a platform admin turns it on. No request reaches AWS,
 * Microsoft or the gateway: the journey stops at the page that hands off to AWS.
 */
export async function aiGatewayCloudSignIn(seed: Seed, context: { place: Place }) {
  const world = await aiGatewayAdmin(seed, context);
  // The teammate signed in to Den in this browser with their password, the way
  // people do, so the browser holds their Den session cookie. OpenWork's connect
  // page checks that cookie before it sends anyone to AWS or Microsoft.
  const signedIn = await seed.api(world.teammate, "/api/auth/sign-in/email", {
    method: "POST", body: JSON.stringify({ email: world.teammate.email, password: world.teammate.password }),
  });
  const sessionCookie = signedIn.response.headers.getSetCookie().find((value) => value.includes("session_token="))?.split(";")[0] ?? "";
  const separator = sessionCookie.indexOf("=");
  if (!signedIn.response.ok || separator < 1) throw new Error(`Could not sign the teammate in with their password: HTTP ${signedIn.response.status}`);
  const applied: unknown = await world.memberWeb.client.send("Network.setCookie", {
    name: sessionCookie.slice(0, separator), value: sessionCookie.slice(separator + 1), url: world.den.ref.webUrl, path: "/", httpOnly: true,
  });
  if (!applied || typeof applied !== "object" || !("success" in applied) || applied.success !== true) throw new Error("Could not give the browser the teammate's Den session cookie.");
  return world;
}
