"use client";

import { t } from "@/i18n";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ModelBehaviorOption = {
  value: string | null;
  label: string;
};

type ModelBehaviorSelectProps = {
  value: string | null;
  label: string;
  options?: ModelBehaviorOption[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
};

export function ModelBehaviorSelect({
  value,
  label,
  options,
  onChange,
  disabled = false,
}: ModelBehaviorSelectProps) {
  if (!options?.length) {
    return null;
  }

  const items = options.flatMap((option) =>
    option.value ? [{ value: option.value, label: option.label }] : [],
  );
  const rawValue = value ?? null;
  const selectValue = items.some((option) => option.value === rawValue)
    ? rawValue
    : items[0]?.value ?? null;

  return (
    <Select
      value={selectValue}
      items={items}
      onValueChange={(nextValue) => {
        const option = options.find((item) => item.value === nextValue);
        
        if (!option) {
          return;
        }

        onChange(option.value ?? null);
      }}
      disabled={disabled}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              size="sm"
              disabled={disabled}
              aria-label={t("composer.behavior_label")}
              className="h-10 border-0 bg-transparent px-2.5 py-1 text-sm rounded-md text-gray-10 shadow-none hover:bg-gray-3 hover:text-gray-12 data-[size=sm]:h-8"
            />
          }
        >
          <SelectValue placeholder={label || t("settings.default_label")} />
        </TooltipTrigger>
        <TooltipContent>{t("composer.behavior_label")}</TooltipContent>
      </Tooltip>
      <SelectContent side="top" sideOffset={8} align="start" className="min-w-48">
        <SelectGroup>
          <SelectLabel>Thinking</SelectLabel>
          {items.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
