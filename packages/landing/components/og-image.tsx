import { OGImageContent } from "./og-image-content";
import { ResponsiveGrain } from "./responsive-grain";

export default function OGImage() {
  return (
    <div className="relative flex h-[630px] w-[1200px] shrink-0 items-center justify-center overflow-hidden bg-[#f6f9fc] font-sans text-[#011627]">
      <div className="pointer-events-none absolute inset-0 z-0 mix-blend-multiply opacity-[0.45]">
        <ResponsiveGrain
          colors={["#f6f9fc", "#1e293b", "#334155", "#475569"]}
          colorBack="#f6f9fc"
          softness={1}
          intensity={0.08}
          noise={0.14}
          shape="corners"
          speed={0}
        />
      </div>
      <OGImageContent />
    </div>
  );
}
