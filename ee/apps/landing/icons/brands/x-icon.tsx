import { cn } from "@/lib/utils";

const XIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      className={cn("text-foreground w-[3.2rem]", className)}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g clipPath="url(#clip0_2021_13592)">
        <path
          d="M25.1888 1.54218H30.0723L19.4056 13.8153L32 30.4578H22.1044L14.3936 20.3695L5.5261 30.4578H0.64257L12.0803 17.3494L0 1.54218H10.1526L17.1566 10.7952L25.1888 1.54218ZM23.4538 27.502H26.1526L8.6747 4.30523H5.71888L23.4538 27.502Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id="clip0_2021_13592">
          <rect width="32" height="28.9157" fill="white" transform="translate(0 1.54218)" />
        </clipPath>
      </defs>
    </svg>
  );
};

export default XIcon;
