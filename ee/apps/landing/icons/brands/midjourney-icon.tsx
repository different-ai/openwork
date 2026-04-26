import { cn } from "@/lib/utils";

const MidjourneyIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[3.2rem]", className)} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2021_13529)">
        <path
          d="M0.42276 28.9314C1.33907 28.9314 2.71353 27.0071 4.31707 26.7323C5.23338 26.7323 5.92061 28.6565 8.21139 28.9314C9.81493 28.9314 10.5022 27.0071 12.1057 27.0071C13.7092 27.0071 14.3965 28.9314 16 28.9314C17.6036 28.9314 18.2908 27.0071 19.8943 27.0071C21.4979 27.0071 22.1851 28.9314 23.7886 28.9314C25.3922 28.9314 26.0794 27.0071 27.683 27.0071C29.2865 27.0071 29.9737 28.9314 31.5773 28.9314"
          stroke="black"
          strokeWidth="0.824678"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3.55653 27.0163L2.50735 25.0096L29.5385 23.2686C27.4126 25.202 24.682 26.7689 21.9194 28.0517"
          stroke="black"
          strokeWidth="0.824678"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13.2694 6.31689C17.8693 7.72343 24.3018 14.5179 26.4917 21.8208C25.2914 21.3489 24.3934 20.8679 22.7074 21.2985C21.0764 15.3654 18.1579 9.69807 13.2694 6.31689Z"
          stroke="black"
          strokeWidth="0.824678"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4.71567 3.06857C10.6075 5.58842 18.6894 12.6028 20.1738 21.9445C13.3794 19.2048 8.20681 20.6663 4.60571 22.8883C10.099 15.9061 7.63411 7.96624 4.71567 3.06857Z"
          stroke="black"
          strokeWidth="0.824678"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <defs>
        <clipPath id="clip0_2021_13529">
          <rect width="32" height="26.6875" fill="white" transform="translate(0 2.65625)" />
        </clipPath>
      </defs>
    </svg>
  );
};

export default MidjourneyIcon;
