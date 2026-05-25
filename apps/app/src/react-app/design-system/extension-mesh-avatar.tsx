/** @jsxImportSource react */
import { StaticMeshGradient } from "@paper-design/shaders-react";

type ExtensionMeshAvatarProps = {
  name: string;
  className?: string;
};

const palettes = [
  ["#e0eaff", "#241d9a", "#f75092", "#9f50d3"],
  ["#a8f976", "#5cf5d9", "#8261fa", "#14e1bc"],
  ["#ffe29f", "#ffa99f", "#ff719a", "#6c5ce7"],
  ["#b8fff9", "#85f4ff", "#8b5cf6", "#111827"],
] as const;

function paletteForName(name: string) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % palettes.length;
  }
  return palettes[hash];
}

function fallbackBackground(colors: readonly string[]) {
  return [
    `radial-gradient(circle at 20% 20%, ${colors[0]}, transparent 38%)`,
    `radial-gradient(circle at 80% 12%, ${colors[1]}, transparent 42%)`,
    `radial-gradient(circle at 52% 90%, ${colors[2]}, transparent 46%)`,
    `linear-gradient(135deg, ${colors[0]}, ${colors[3]})`,
  ].join(", ");
}

export function extensionMeshAvatarText(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2
    ? `${words[0][0]}${words[1][0]}`
    : (words[0] ?? "E").slice(0, 2);
  return letters.toUpperCase();
}

export function ExtensionMeshAvatar({ name, className }: ExtensionMeshAvatarProps) {
  const colors = paletteForName(name);

  return (
    <div
      className={`relative isolate overflow-hidden ${className ?? ""}`}
      style={{ background: fallbackBackground(colors) }}
    >
      <StaticMeshGradient
        className="absolute -inset-2 h-[calc(100%+1rem)] w-[calc(100%+1rem)]"
        width={96}
        height={96}
        colors={[...colors]}
        positions={4}
        waveX={0.36}
        waveY={0.42}
        waveXShift={0.18}
        waveYShift={0.12}
        mixing={0.72}
        grainMixer={0}
        grainOverlay={0}
        speed={0}
        maxPixelCount={9216}
      />
      <div className="absolute inset-0 flex items-center justify-center bg-black/5 text-white drop-shadow-sm">
        {extensionMeshAvatarText(name)}
      </div>
    </div>
  );
}
