import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const FILE_SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;
const fileSizeFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function formatFileSize(bytes: number) {
  if (Math.abs(bytes) < 1024) {
    return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  }

  let value = bytes / 1024;
  let unit: string = FILE_SIZE_UNITS[0];

  for (let index = 1; Math.abs(value) >= 1024 && index < FILE_SIZE_UNITS.length; index += 1) {
    value /= 1024;
    unit = FILE_SIZE_UNITS[index];
  }

  return `${fileSizeFormatter.format(value)} ${unit}`;
}
