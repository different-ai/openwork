import { cn } from "@/lib/utils";

const SheetsIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[3.2rem]", className)} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_116_496)">
        <path d="M19.6364 0L27.6364 8L23.6364 8.72727L19.6364 8L18.9091 4L19.6364 0Z" fill="#188038" />
        <path
          d="M19.6364 8V0H6.54547C5.34001 0 4.36365 0.976364 4.36365 2.18182V29.8182C4.36365 31.0236 5.34001 32 6.54547 32H25.4546C26.66 32 27.6364 31.0236 27.6364 29.8182V8H19.6364Z"
          fill="#34A853"
        />
        <path
          d="M8.72729 12.3636V22.9091H23.2727V12.3636H8.72729ZM15.0909 21.0909H10.5455V18.5455H15.0909V21.0909ZM15.0909 16.7273H10.5455V14.1818H15.0909V16.7273ZM21.4546 21.0909H16.9091V18.5455H21.4546V21.0909ZM21.4546 16.7273H16.9091V14.1818H21.4546V16.7273Z"
          fill="white"
        />
      </g>
      <defs>
        <clipPath id="clip0_116_496">
          <rect width="23.2727" height="32" fill="white" transform="translate(4.36365)" />
        </clipPath>
      </defs>
    </svg>
  );
};

export default SheetsIcon;
