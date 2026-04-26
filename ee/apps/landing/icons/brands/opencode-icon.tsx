import { cn } from "@/lib/utils";

const OpenCodeIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn("w-[2.4rem]", className)}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"
        fill="currentColor"
      />
    </svg>
  );
};

export default OpenCodeIcon;
