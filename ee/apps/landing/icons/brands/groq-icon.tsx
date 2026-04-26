import { cn } from "@/lib/utils";

const GroqIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn("w-[2.4rem]", className)}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
      <path
        d="M8 9c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v6c0 1.1-.9 2-2 2h-2v-2h2V9h-4v6h2v2h-2c-1.1 0-2-.9-2-2V9z"
        fill="currentColor"
      />
    </svg>
  );
};

export default GroqIcon;
