import { cn } from "@/lib/utils";

const SunIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[1.8rem]", className)} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0.5V3" stroke="currentColor"></path>
      <path d="M23.5 12H21" stroke="currentColor"></path>
      <path d="M0.5 12H3" stroke="currentColor"></path>
      <path d="M20.1 3.90002L18.4 5.60002" stroke="currentColor"></path>
      <path d="M3.89999 3.90002L5.59999 5.60002" stroke="currentColor"></path>
      <path d="M12 23.5V21" stroke="currentColor"></path>
      <path d="M3.89999 20.1L5.59999 18.4" stroke="currentColor"></path>
      <path d="M20.1 20.1L18.4 18.4" stroke="currentColor"></path>
      <path
        d="M12 17.5C15.0376 17.5 17.5 15.0376 17.5 12C17.5 8.96243 15.0376 6.5 12 6.5C8.96243 6.5 6.5 8.96243 6.5 12C6.5 15.0376 8.96243 17.5 12 17.5Z"
        stroke="currentColor"
      ></path>
    </svg>
  );
};

export default SunIcon;
