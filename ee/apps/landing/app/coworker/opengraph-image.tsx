import { ImageResponse } from "next/og";
import { StaticCoworkerAvatar } from "@openwork/ui/coworker-artwork";
import { CoworkerMark } from "../../components/coworker-brand";
import { HERO } from "../../lib/coworker-content";
import { TEAM } from "../../lib/coworker-demo";

export const alt = "Open Coworker — Your work. Better together.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function CoworkerSocialImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "64px 76px", background: "#090c12", color: "#f5f7fb", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 26 }}>
        <CoworkerMark size={46} /><span>Open Coworker</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 48, fontSize: 82, letterSpacing: -4, lineHeight: 1.06 }}>
        <span>Your work.</span><span style={{ color: "#bdc5d1" }}>Better together.</span>
      </div>
      <div style={{ display: "flex", maxWidth: 700, marginTop: 30, color: "#9ba7b9", fontSize: 25, lineHeight: 1.5 }}>{HERO.lead}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
        <span style={{ fontSize: 19, color: "#9ba7b9" }}>Free and open source · Early access for macOS</span>
        <div style={{ display: "flex", gap: 12 }}>
          {TEAM.map((coworker) => <StaticCoworkerAvatar key={coworker.id} name={coworker.name} color={coworker.color} glasses={coworker.glasses} size={62} />)}
        </div>
      </div>
    </div>,
    size,
  );
}
