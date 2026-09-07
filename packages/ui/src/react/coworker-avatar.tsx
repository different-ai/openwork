"use client";

import { useCallback, useRef } from "react";
import { StaticCoworkerAvatar, type StaticCoworkerAvatarProps, type AvatarColor, type AvatarGlasses } from "./coworker-avatar-artwork";
import { useAvatarMotion, type AvatarGather } from "./coworker-avatar-motion";

export type { AvatarColor, AvatarGlasses } from "./coworker-avatar-artwork";
export { acknowledgeCoworker } from "./coworker-avatar-motion";
export type { AvatarMotion, AvatarReaction } from "./coworker-avatar-motion";

const AVATAR_COLORS: Array<{ id: AvatarColor; label: string; swatch: string }> = [
  { id: "blue", label: "OpenWork blue", swatch: "#b8c9f0" },
  { id: "violet", label: "Violet", swatch: "#c8c1e2" },
  { id: "mint", label: "Mint", swatch: "#b2d5cb" },
  { id: "orange", label: "Orange", swatch: "#e4c3ad" },
  { id: "rose", label: "Rose", swatch: "#e2c1cb" },
  { id: "slate", label: "Pearl", swatch: "#e3e6ea" },
  { id: "sand", label: "Sand", swatch: "#ded0b0" },
  { id: "sage", label: "Sage", swatch: "#becab4" },
];

const AVATAR_GLASSES: Array<{ id: AvatarGlasses; label: string }> = [
  { id: "round", label: "Round" },
  { id: "square", label: "Soft square" },
  { id: "oval", label: "Oval" },
  { id: "none", label: "None" },
  { id: "sunglasses", label: "Sunglasses" },
  { id: "monocle", label: "Monocle" },
];

export type CoworkerAvatarProps = StaticCoworkerAvatarProps & { gaze?: boolean };

export function CoworkerAvatar(props: CoworkerAvatarProps) {
  return <AnimatedAvatar {...props} />;
}

function AnimatedAvatar({
  name,
  color,
  glasses,
  size = 96,
  animated = true,
  working = false,
  svgRef,
  identity = name,
  motion = size <= 44 ? "quiet" : "attentive",
  gaze = true,
  gather,
}: CoworkerAvatarProps & { gather?: AvatarGather }) {
  const motionRef = useAvatarMotion({ identity, motion, animated, gaze, prominent: motion !== "quiet" && motion !== "navigation", gather });
  // A stable callback avoids detaching the observed SVG on ordinary parent renders.
  const setRef = useCallback((node: SVGSVGElement | null) => {
    motionRef.current = node;
    if (typeof svgRef === "function") return svgRef(node);
    if (svgRef) svgRef.current = node;
  }, [motionRef, svgRef]);

  return <StaticCoworkerAvatar name={name} color={color} glasses={glasses} size={size} animated={animated} working={working} identity={identity} motion={motion} svgRef={setRef} />;
}

export type GroupAvatarsProps = {
  members: readonly { slug: string; name: string; avatarColor: AvatarColor; avatarGlasses: AvatarGlasses }[];
  size?: number;
  animated?: boolean;
  activeSlugs?: readonly string[];
  /** Set only on a prominent group header, not its rail or transcript copies. */
  gatherKey?: string;
};

export function GroupAvatars({ members, size = 26, animated = true, activeSlugs = [], gatherKey }: GroupAvatarsProps) {
  const owner = useRef({});
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  const step = Math.round(size * 0.94);
  const countWidth = Math.max(Math.round(size * 0.7), String(extra).length * 6 + 12);
  const facesWidth = shown.length ? size + step * (shown.length - 1) : size;
  const width = facesWidth + (extra > 0 ? countWidth + 2 : 0);
  return (
    <span className="coworker-avatar-group" style={{ width, height: size }} data-testid="group-avatars" data-count={members.length} data-context={gatherKey === undefined ? "rail" : "header"} role="img" aria-label={members.length ? `Group: ${members.map((member) => member.name).join(", ")}` : "Group"}>
      {shown.map((member, index) => (
        <span key={member.slug} className="coworker-avatar-group__member" aria-hidden="true" data-active={activeSlugs.includes(member.slug)} style={{ left: index * step, width: size, height: size }}>
          <AnimatedAvatar name={member.name} identity={member.slug} color={member.avatarColor} glasses={member.avatarGlasses} size={size} animated={animated} motion="quiet" gaze={false} gather={gatherKey === undefined ? undefined : { key: gatherKey, owner: owner.current, index }} />
        </span>
      ))}
      {extra > 0 ? <span aria-hidden="true" className="coworker-avatar-group__extra" style={{ left: facesWidth + 2, width: countWidth, height: size }}>+{extra}</span> : null}
    </span>
  );
}

export function AvatarControls({
  color,
  glasses,
  onColorChange,
  onGlassesChange,
  layout = "stacked",
}: {
  color: AvatarColor;
  glasses: AvatarGlasses;
  onColorChange: (color: AvatarColor) => void;
  onGlassesChange: (glasses: AvatarGlasses) => void;
  /** `rows` lays each choice out as a label beside its control, for flat settings lists. */
  layout?: "stacked" | "rows";
}) {
  if (layout === "rows") {
    return (
      <>
        <div className="flex items-center gap-3 py-2.5" role="group" aria-label="Color">
          <span className="w-20 shrink-0 text-xs text-mist">Color</span>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((option) => (
              <button
                key={option.id}
                aria-label={option.label}
                aria-pressed={color === option.id}
                className={`avatar-swatch ${color === option.id ? "is-selected" : ""}`}
                onClick={() => onColorChange(option.id)}
                title={option.label}
                type="button"
              >
                <span style={{ backgroundColor: option.swatch }} />
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 py-2.5" role="group" aria-label="Glasses">
          <span className="w-20 shrink-0 text-xs text-mist">Glasses</span>
          <div className="flex flex-wrap gap-1">
            {AVATAR_GLASSES.map((option) => (
              <button
                key={option.id}
                aria-pressed={glasses === option.id}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  glasses === option.id ? "bg-white/10 text-snow" : "text-mist hover:bg-white/5 hover:text-snow"
                }`}
                onClick={() => onGlassesChange(option.id)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-mist">Color</legend>
        <div className="flex flex-wrap gap-2">
          {AVATAR_COLORS.map((option) => (
            <button
              key={option.id}
              aria-label={option.label}
              aria-pressed={color === option.id}
              className={`avatar-swatch ${color === option.id ? "is-selected" : ""}`}
              onClick={() => onColorChange(option.id)}
              title={option.label}
              type="button"
            >
              <span style={{ backgroundColor: option.swatch }} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-mist">Glasses</legend>
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-black/20 p-1">
          {AVATAR_GLASSES.map((option) => (
            <button
              key={option.id}
              aria-pressed={glasses === option.id}
              className={`rounded-lg px-2 py-2 text-[11px] font-medium transition-all ${
                glasses === option.id
                  ? "bg-white/10 text-snow ring-1 ring-white/10"
                  : "text-mist hover:bg-white/5 hover:text-snow"
              }`}
              onClick={() => onGlassesChange(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
