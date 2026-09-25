import type { Metadata } from "next";
import { OAuthErrorScreen } from "./oauth-error-screen";

export const metadata: Metadata = {
  title: "Sign-in failed — OpenWork",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * Where Better Auth sends OAuth authorization errors that cannot be returned to
 * the client (unknown client, unregistered redirect URI, malformed request).
 * Public: the person arriving here usually has no session yet.
 */
export default function OAuthErrorPage() {
  return <OAuthErrorScreen />;
}
