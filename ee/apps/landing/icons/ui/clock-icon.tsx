import { cn } from "@/lib/utils";

const ClockIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[2.4rem]", className)} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11.5 6V12.5L16.5 15" stroke="currentColor"></path>
      <path
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"
        stroke="currentColor"
      ></path>
    </svg>
  );
};

export default ClockIcon;
