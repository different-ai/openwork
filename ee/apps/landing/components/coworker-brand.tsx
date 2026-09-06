/** The site and desktop app share coworker artwork and appearance controls. */
export { CoworkerAvatar, AvatarControls, GroupAvatars, acknowledgeCoworker } from "@openwork/ui/coworker";
export type { AvatarColor, AvatarGlasses } from "@openwork/ui/coworker";

const BUBBLE_PATH = "M26 8h65c15 0 23 10 23 26v46c0 15-8 24-23 24H57l-15 9c-5 3-10 0-10-6v-3h-5C12 104 5 95 5 80V34C5 18 12 8 26 8Z";

/** The app icon: a white speech bubble with round glasses on a light tile. */
export function CoworkerMark({ size = 44, label, tile = true, className = "" }: { size?: number; label?: string; tile?: boolean; className?: string }) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      className={className}
      style={{ width: size, height: size }}
      viewBox="0 0 122 122"
    >
      {tile ? <rect x="3" y="3" width="116" height="116" rx="29" fill="#f7f8fa" /> : null}
      {tile ? <rect x="3.5" y="3.5" width="115" height="115" rx="28.5" fill="none" stroke="#d8dde5" /> : null}
      <g transform={tile ? "translate(14.7 14.5) scale(0.76)" : "translate(1 2)"}>
        {tile ? <path d={BUBBLE_PATH} fill="#d9dde4" stroke="#aeb5c0" strokeLinejoin="round" strokeWidth="2.4" transform="translate(5.2 2.8)" /> : null}
        <path d={BUBBLE_PATH} fill="#f7f8fa" />
        <path d={BUBBLE_PATH} fill="none" stroke="#11151d" strokeLinejoin="round" strokeWidth="3.4" />
        <g fill="#0b0e14">
          <rect x="34.5" y="50" width="6" height="14" rx="3" />
          <rect x="79.5" y="50" width="6" height="14" rx="3" />
        </g>
        <g fill="none" stroke="#11151d" strokeLinecap="round" strokeWidth="4.6">
          <circle cx="37.5" cy="57" r="17.5" />
          <circle cx="82.5" cy="57" r="17.5" />
          <path d="M57.5 57c1.25-4 3.75-4 5 0" />
          <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
        </g>
      </g>
    </svg>
  );
}
