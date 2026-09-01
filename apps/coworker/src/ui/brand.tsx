import { useAvatarPointerGaze } from "@/ui/use-avatar-pointer-gaze";

const BUBBLE_PATH =
  "M26 8h65c15 0 23 10 23 26v46c0 15-8 24-23 24H57l-15 9c-5 3-10 0-10-6v-3h-5C12 104 5 95 5 80V34C5 18 12 8 26 8Z";

export function CoworkerMark({
  size = 44,
  animated = false,
  loading = false,
  label,
  className = "",
}: {
  size?: number;
  animated?: boolean;
  loading?: boolean;
  label?: string;
  className?: string;
}) {
  const motionClass = loading ? "is-loading" : animated ? "is-animated" : "";
  const avatarRef = useAvatarPointerGaze();

  return (
    <svg
      ref={avatarRef}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={`coworker-mark ${motionClass} ${className}`}
      role={label ? "img" : undefined}
      style={{ width: size, height: size }}
      viewBox="0 0 122 122"
    >
      <rect x="3" y="3" width="116" height="116" rx="29" fill="#5b8dff" />
      <rect x="3.5" y="3.5" width="115" height="115" rx="28.5" fill="none" stroke="#8aa9ff" strokeOpacity="0.58" />
      <g transform="translate(14.7 14.5) scale(0.76)">
        <g className="coworker-mark__body">
          <g className="coworker-mark__depth">
            <path d={BUBBLE_PATH} fill="#284f9f" opacity="0.68" transform="translate(3 3)" />
          </g>
          <path d={BUBBLE_PATH} fill="#f7f8fa" stroke="#ffffff" strokeWidth="1.1" />
          <g className="coworker-mark__features">
            <g className="coworker-mark__pointer-gaze">
              <g className="coworker-mark__gaze">
                <g className="coworker-mark__pupils" fill="#0b0e14">
                  <rect x="34.5" y="50" width="6" height="14" rx="3" />
                  <rect x="79.5" y="50" width="6" height="14" rx="3" />
                </g>
              </g>
            </g>
            <g fill="none" stroke="#11151d" strokeLinecap="round" strokeWidth="5">
              <circle cx="37.5" cy="57" r="17.5" />
              <circle cx="82.5" cy="57" r="17.5" />
              <path d="M57.5 57c1.25-4 3.75-4 5 0" />
              <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

export function AppLoader({
  message = "Preparing Open Coworker",
  detail = "Starting your local workspace",
}: {
  message?: string;
  detail?: string;
}) {
  return (
    <div className="window-shell window-drag flex h-full items-center justify-center" data-testid="coworker-app-loader">
      <div className="brand-loader" role="status" aria-live="polite">
        <CoworkerMark loading label="Open Coworker" size={88} />
        <p className="brand-loader__name">Open Coworker</p>
        <p className="brand-loader__message">{message}</p>
        <div className="brand-loader__progress" aria-hidden="true"><span /></div>
        <p className="brand-loader__detail">{detail}</p>
      </div>
    </div>
  );
}

export function InlineLoader({ label }: { label: string }) {
  return (
    <span className="inline-loader" role="status">
      <span className="inline-loader__progress" aria-hidden="true"><span /></span>
      <span>{label}</span>
    </span>
  );
}
