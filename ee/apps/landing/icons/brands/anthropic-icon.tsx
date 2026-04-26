import { cn } from "@/lib/utils";

const AnthropicIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn("w-[2.4rem]", className)}
      viewBox="0 0 256 176"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M147.487 0H183.31L256 176H220.176L147.487 0ZM72.69 0L0 176H36.5067L51.4933 137.493H127.488L142.475 176H178.981L106.291 0H72.69ZM63.0506 107.115L89.4906 38.1333L115.931 107.115H63.0506Z"
        fill="currentColor"
      />
    </svg>
  );
};

export default AnthropicIcon;
