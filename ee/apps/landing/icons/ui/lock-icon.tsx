import { cn } from "@/lib/utils";

const LockIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn("text-primary w-[3.2rem]", className)}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M5.69106 25.1263C5.9909 27.3533 7.83549 29.098 10.0802 29.2012C11.969 29.288 13.8877 29.3333 16.0007 29.3333C18.1136 29.3333 20.0323 29.288 21.9211 29.2012C24.1659 29.098 26.0104 27.3533 26.3103 25.1263C26.506 23.6729 26.6673 22.1835 26.6673 20.6667C26.6673 19.1499 26.506 17.6604 26.3103 16.2071C26.0104 13.98 24.1659 12.2353 21.9211 12.1321C20.0323 12.0453 18.1136 12 16.0007 12C13.8877 12 11.969 12.0453 10.0802 12.1321C7.83549 12.2353 5.9909 13.98 5.69106 16.2071C5.49537 17.6604 5.33398 19.1499 5.33398 20.6667C5.33398 22.1835 5.49537 23.6729 5.69106 25.1263Z"
        stroke="currentColor"
        strokeWidth="2"
        fill="var(--background-muted)"
      />
      <path
        d="M10 12.0003V8.66699C10 5.35329 12.6863 2.66699 16 2.66699C19.3137 2.66699 22 5.35329 22 8.66699V12.0003"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.9941 20.667H16.0061"
        stroke="currentColor"
        strokeWidth="2.66667"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="var(--background-muted)"
      />
    </svg>
  );
};

export default LockIcon;
