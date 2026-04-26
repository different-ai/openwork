import { cn } from "@/lib/utils";

const FileIcon = ({ className }: { className?: string }) => {
  return (
    <svg className={cn("w-[1.2rem]", className)} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 2H4V22H20V8L14 2Z" stroke="currentColor" strokeMiterlimit="10"></path>
      <path d="M14 2V8H20" stroke="currentColor" strokeMiterlimit="10"></path>
    </svg>
  );
};

export default FileIcon;
