export const COMPACT_MENU_CONTENT_CLASS = [
  "rounded-[14px] bg-popover p-1.5 shadow-[var(--dls-shell-shadow)] ring-0 before:hidden dark:ring-0",
  "**:data-[slot=dropdown-menu-item]:min-h-8 **:data-[slot=dropdown-menu-item]:gap-2.5 **:data-[slot=dropdown-menu-item]:rounded-lg **:data-[slot=dropdown-menu-item]:px-2 **:data-[slot=dropdown-menu-item]:py-1.5",
  "**:data-[slot=dropdown-menu-item]:text-[13px] **:data-[slot=dropdown-menu-item]:font-normal **:data-[slot=dropdown-menu-item]:text-gray-11",
  "**:data-[slot=dropdown-menu-sub-trigger]:min-h-8 **:data-[slot=dropdown-menu-sub-trigger]:gap-2.5 **:data-[slot=dropdown-menu-sub-trigger]:rounded-lg **:data-[slot=dropdown-menu-sub-trigger]:px-2 **:data-[slot=dropdown-menu-sub-trigger]:py-1.5",
  "**:data-[slot=dropdown-menu-sub-trigger]:text-[13px] **:data-[slot=dropdown-menu-sub-trigger]:font-normal **:data-[slot=dropdown-menu-sub-trigger]:text-gray-11",
  "**:data-[slot$=-item]:data-highlighted:bg-gray-3! **:data-[slot$=-item]:focus:bg-gray-3! **:data-[slot$=-item]:data-highlighted:text-gray-12 **:data-[slot$=-item]:focus:text-gray-12",
  "**:data-[slot=dropdown-menu-sub-trigger]:data-highlighted:bg-gray-3! **:data-[slot=dropdown-menu-sub-trigger]:data-popup-open:bg-gray-3! **:data-[slot=dropdown-menu-sub-trigger]:data-highlighted:text-gray-12",
  "**:data-[slot$=-separator]:bg-gray-3! [&_[data-slot=dropdown-menu-item]_svg]:size-4! [&_[data-slot=dropdown-menu-item]_svg]:text-gray-10",
  "[&_[data-slot=dropdown-menu-sub-trigger]_svg]:size-4! [&_[data-slot=dropdown-menu-sub-trigger]_svg]:text-gray-10",
].join(" ");
