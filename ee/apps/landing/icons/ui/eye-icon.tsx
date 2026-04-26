import { cn } from "@/lib/utils";

const EyeIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[1.2rem]", className)} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22 12C21.0113 13.794 19.5653 15.2941 17.8088 16.348C16.0524 17.4019 14.0482 17.9719 12 18C9.95184 17.9719 7.94764 17.4019 6.19119 16.348C4.43474 15.2941 2.98867 13.794 2 12C2.98867 10.206 4.43474 8.70586 6.19119 7.65199C7.94764 6.59812 9.95184 6.02814 12 6C14.0482 6.02814 16.0524 6.59812 17.8088 7.65199C19.5653 8.70586 21.0113 10.206 22 12Z"
        stroke="currentColor"
      ></path>
      <path
        d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"
        stroke="currentColor"
      ></path>
    </svg>
  );
};

export default EyeIcon;
