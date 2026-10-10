/**
 * Small service marks for product previews. Simplified shapes in each
 * service's colours so a person recognises the tool at 16-20px (DESIGN.md V5).
 */

type MarkProps = {
  className?: string;
};

export function LinearMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#5E6AD2" />
      <path
        d="M5 13.5 10.5 19M5 10l9 9M6.5 7.5l10 10M9 5.5l9.5 9.5"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SlackMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="9.5" y="2" width="3.2" height="9" rx="1.6" fill="#36C5F0" />
      <rect x="13" y="9.5" width="9" height="3.2" rx="1.6" fill="#2EB67D" />
      <rect x="11.3" y="13" width="3.2" height="9" rx="1.6" fill="#ECB22E" />
      <rect x="2" y="11.3" width="9" height="3.2" rx="1.6" fill="#E01E5A" />
    </svg>
  );
}

export function GoogleDriveMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M8 3h8l7 12h-8Z" fill="#FBBC04" />
      <path d="M8 3 1 15l4 7 7-12Z" fill="#0F9D58" />
      <path d="M5 22h14l4-7H9Z" fill="#4285F4" />
    </svg>
  );
}

export function GoogleMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z" fill="#4285F4" />
      <path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" fill="#34A853" />
      <path d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2Z" fill="#FBBC05" />
      <path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6Z" fill="#EA4335" />
    </svg>
  );
}

export function MicrosoftMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="3" y="3" width="8.5" height="8.5" fill="#F25022" />
      <rect x="12.5" y="3" width="8.5" height="8.5" fill="#7FBA00" />
      <rect x="3" y="12.5" width="8.5" height="8.5" fill="#00A4EF" />
      <rect x="12.5" y="12.5" width="8.5" height="8.5" fill="#FFB900" />
    </svg>
  );
}

export function VsCodeMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#0078D4" />
      <path
        d="M16.5 5v14L7 12.2l-2 1.6V10.2l2 1.6Z M16.5 5 9.5 11.5M16.5 19l-7-6.5"
        stroke="#fff"
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TerminalMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#0B0B0B" />
      <path d="m8 9 3 3-3 3M13 15h4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function OpenCodeMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#111111" />
      <rect x="7" y="6" width="10" height="12" rx="1.5" fill="none" stroke="#fff" strokeWidth="1.8" />
    </svg>
  );
}

export function SkillMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#E8EDF4" />
      <path d="M8 7h8M8 12h8M8 17h5" stroke="#011627" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
