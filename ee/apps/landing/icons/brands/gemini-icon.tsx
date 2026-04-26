import { cn } from "@/lib/utils";

const GeminiIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn("w-[2.4rem]", className)}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12"
        fill="currentColor"
      />
    </svg>
  );
};

export default GeminiIcon;
