type Props = {
  className?: string;
};

export function SocTypeIBadge(props: Props) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={props.className}
      role="img"
      aria-hidden="true"
    >
      <circle cx="32" cy="32" r="31" fill="#011627" />
      <circle
        cx="32"
        cy="32"
        r="27.5"
        fill="none"
        stroke="#fcfdfe"
        strokeWidth="1.25"
      />
      <circle
        cx="32"
        cy="32"
        r="24"
        fill="none"
        stroke="#fcfdfe"
        strokeOpacity="0.35"
        strokeWidth="0.75"
      />
      <text
        x="32"
        y="27"
        textAnchor="middle"
        fill="#fcfdfe"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="13"
        fontWeight="700"
        letterSpacing="0.02em"
      >
        SOC 2
      </text>
      <rect x="14" y="33" width="36" height="13" rx="6.5" fill="#fcfdfe" />
      <text
        x="32"
        y="42.5"
        textAnchor="middle"
        fill="#011627"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="8"
        fontWeight="700"
        letterSpacing="0.06em"
      >
        TYPE I
      </text>
    </svg>
  );
}
