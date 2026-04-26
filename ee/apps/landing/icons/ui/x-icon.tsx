import { cn } from "@/lib/utils";

const XIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[1.8rem]", className)} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M14.25 3.75L3.75 14.25"
        stroke="currentColor"
        strokeWidth="2"
        strokeMiterlimit="10"
        strokeLinecap="round"
      />
      <path
        d="M3.75 3.75L14.25 14.25"
        stroke="currentColor"
        strokeWidth="2"
        strokeMiterlimit="10"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default XIcon;
