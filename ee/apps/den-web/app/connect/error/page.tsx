import type { Metadata } from "next";
import { OAuthErrorScreen } from "./oauth-error-screen";

export const metadata: Metadata = {
  title: "Sign-in failed — OpenWork",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function OAuthErrorPage() {
  return <OAuthErrorScreen />;
}
