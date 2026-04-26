import { cn } from "@/lib/utils";

const DropboxIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[3.2rem]", className)} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2021_13611)">
        <path d="M8.00138 12.603L16.0007 7.50744L8.00138 2.4119L0.00341797 7.50744L8.00138 12.603Z" fill="#0061FF" />
        <path d="M23.9986 12.603L31.9966 7.50744L23.9986 2.4119L16.0007 7.50744L23.9986 12.603Z" fill="#0061FF" />
        <path d="M16.0007 17.6985L8.00138 12.603L0.00341797 17.6985L8.00138 22.794L16.0007 17.6985Z" fill="#0061FF" />
        <path d="M23.9986 22.794L31.9966 17.6985L23.9986 12.603L16.0007 17.6985L23.9986 22.794Z" fill="#0061FF" />
        <path d="M23.9986 24.4926L16.0007 19.397L8.00134 24.4926L16.0007 29.5881L23.9986 24.4926Z" fill="#0061FF" />
      </g>
      <defs>
        <clipPath id="clip0_2021_13611">
          <rect width="32" height="27.2102" fill="white" transform="translate(0 2.3949)" />
        </clipPath>
      </defs>
    </svg>
  );
};

export default DropboxIcon;
