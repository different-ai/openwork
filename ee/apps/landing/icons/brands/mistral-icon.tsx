import { cn } from "@/lib/utils";

const MistralIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn("w-[2.4rem]", className)}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2" y="2" width="4" height="4" fill="currentColor" />
      <rect x="2" y="6" width="20" height="4" fill="currentColor" />
      <rect x="2" y="10" width="4" height="4" fill="currentColor" />
      <rect x="14" y="10" width="4" height="4" fill="currentColor" />
      <rect x="2" y="14" width="20" height="4" fill="currentColor" />
      <rect x="2" y="18" width="4" height="4" fill="currentColor" />
      <rect x="18" y="18" width="4" height="4" fill="currentColor" />
    </svg>
  );
};

export default MistralIcon;
