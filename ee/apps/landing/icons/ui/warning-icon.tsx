import { cn } from "@/lib/utils";

const WarningIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[1.8rem]", className)} viewBox="0 0 18 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10.3365 15.1241H7.25679C3.55244 15.1241 1.70027 15.1241 1.01772 13.9192C0.33517 12.7144 1.28252 11.1172 3.17723 7.92292L4.71709 5.32679C6.53711 2.25835 7.44711 0.724121 8.79663 0.724121C10.1462 0.724121 11.0562 2.25834 12.8762 5.32678L14.4161 7.92292C16.3107 11.1172 17.2581 12.7144 16.5755 13.9192C15.893 15.1241 14.0408 15.1241 10.3365 15.1241Z"
        stroke="#0049FF"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.79663 5.52393V9.12393"
        stroke="#0049FF"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.79651 11.918V11.926"
        stroke="#0049FF"
        strokeWidth="1.44"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default WarningIcon;
