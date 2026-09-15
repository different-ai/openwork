import { ImageResponse } from "next/og";
import { StaticCoworkerAvatar } from "@openwork/ui/coworker-artwork";
import { CoworkerMark } from "../../components/coworker-brand";
import { HERO } from "../../lib/coworker-content";
import { TEAM } from "../../lib/coworker-demo";

export const alt = `Open Coworker — ${HERO.title}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function CoworkerSocialImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "52px 68px", background: "#090c12", color: "#f5f7fb", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 26 }}>
        <CoworkerMark size={46} /><span>Open Coworker</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 40, fontSize: 70, letterSpacing: -3, lineHeight: 1.08 }}>
        {HERO.lines.map((line, index) => <span key={line} style={{ color: index === 0 ? "#f5f7fb" : "#bdc5d1" }}>{line}</span>)}
      </div>
      <div style={{ display: "flex", maxWidth: 940, marginTop: 24, color: "#9ba7b9", fontSize: 23, lineHeight: 1.5 }}>{HERO.lead}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
        <span style={{ fontSize: 19, color: "#9ba7b9" }}>Free and open source · macOS alpha available</span>
        <div style={{ display: "flex", gap: 12 }}>
          {TEAM.map((coworker) => <StaticCoworkerAvatar key={coworker.id} name={coworker.name} color={coworker.color} glasses={coworker.glasses} size={62} />)}
        </div>
      </div>
    </div>,
    size,
  );
}
