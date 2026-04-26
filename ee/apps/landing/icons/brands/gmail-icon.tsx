import { cn } from "@/lib/utils";

const GmailIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[3.2rem]", className)} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_116_398)">
        <path
          d="M2.18767 28.0107H7.29223V15.6569L0 10.1662V25.8231C0 27.0242 0.986595 28.0107 2.18767 28.0107Z"
          fill="#4285F4"
        />
        <path
          d="M24.7507 28.0107H29.8552C31.0563 28.0107 32.0429 27.0242 32.0429 25.8231V10.1662L24.7507 15.614"
          fill="#34A853"
        />
        <path
          d="M24.7507 6.17697V15.6569L32.0429 10.2091V7.24935C32.0429 4.54694 28.9544 3.0027 26.8097 4.63273"
          fill="#FBBC04"
        />
        <path d="M7.29222 15.6569V6.17697L16.0429 12.74L24.7507 6.17697V15.6569L16 22.177" fill="#EA4335" />
        <path
          d="M0 7.24935V10.1662L7.29223 15.614V6.17697L5.23324 4.63273C3.08847 3.0456 0 4.58984 0 7.24935Z"
          fill="#C5221F"
        />
      </g>
      <defs>
        <clipPath id="clip0_116_398">
          <rect width="32" height="24.0214" fill="white" transform="translate(0 3.98927)" />
        </clipPath>
      </defs>
    </svg>
  );
};

export default GmailIcon;
