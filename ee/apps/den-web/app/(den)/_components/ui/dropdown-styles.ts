export const denDropdownFieldBaseClass = [
  "w-full border border-gray-200 bg-white",
  "h-[42px] px-4 pr-10 text-[14px] leading-5 text-gray-900",
  "outline-none transition-all focus:border-gray-300 focus:ring-2 focus:ring-gray-900/5",
].join(" ");

export const denDropdownFieldOpenClass = "border-gray-300 ring-2 ring-gray-900/5";

export const denDropdownChevronSlotClass = "pointer-events-none absolute inset-y-0 right-3 flex items-center";

export const denDropdownMenuBaseClass = [
  "absolute left-0 top-[calc(100%+0.375rem)] z-30 w-full overflow-hidden rounded-lg",
  "border border-gray-200 bg-white shadow-[0_20px_44px_-28px_rgba(15,23,42,0.22)]",
].join(" ");

export const denDropdownListClass = "max-h-72 overflow-y-auto p-1.5";

export const denDropdownRowBaseClass = "flex w-full justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition";

export const denDropdownRowIdleClass = "bg-white hover:bg-gray-50";

export const denDropdownRowActiveClass = "bg-gray-50";

export const denDropdownRowSelectedClass = "bg-gray-50/80";
