import type { Metadata } from "next";
import { GatewayConnect } from "./gateway-connect";

export const metadata: Metadata = {
  title: "Connect Google for AI Gateway — OpenWork",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function GatewayConnectPage() {
  return <GatewayConnect />;
}
