type Props = {
  contactHref?: string;
};

export function WaitlistForm(props: Props) {
  const href = props.contactHref || "/enterprise#book";

  return (
    <div className="flex flex-wrap items-center gap-3">
      <a href={href} className="doc-button">
        Contact sales
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M14 5l7 7m0 0l-7 7m7-7H3"
          />
        </svg>
      </a>
      <p className="text-[13px] text-gray-500">
        Cloud signup is temporarily paused while we onboard teams directly.
      </p>
    </div>
  );
}
