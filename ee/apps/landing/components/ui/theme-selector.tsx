"use client";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import MoonIcon from "@/icons/ui/moon-icon";
import SunIcon from "@/icons/ui/sun-icon";
import { cn } from "@/lib/utils";
import { useTheme } from "@/providers/theme-provider";

const ThemeSelector = ({ className }: { className?: string }) => {
  const { theme, toggleTheme, mounted } = useTheme();

  if (!mounted) return null;

  return (
    <button
      data-theme={theme}
      onClick={toggleTheme}
      className={cn(
        "border-foreground/60 bg-background text-foreground group relative z-0 size-[4rem] cursor-pointer overflow-hidden rounded-full border border-dashed",
        className,
      )}
    >
      <div className="ease-primary absolute top-1/2 left-1/2 -translate-x-1/2 translate-y-[250%] rotate-90 transition-transform duration-700 will-change-transform group-hover:scale-110 group-hover:rotate-12 group-data-[theme=light]:-translate-y-1/2 group-data-[theme=light]:rotate-0">
        <SunIcon />
      </div>
      <div className="ease-primary absolute top-1/2 left-1/2 -translate-1/2 -translate-y-[250%] rotate-0 transition-transform duration-700 will-change-transform group-hover:scale-110 group-hover:rotate-12 group-data-[theme=dark]:-translate-y-1/2 group-data-[theme=light]:-rotate-90">
        <MoonIcon />
      </div>
    </button>
  );
};

const ThemeSelectorSecondary = function({ className }: { className?: string }) {
  const { theme, setTheme, mounted } = useTheme();
  if (!mounted) return null;

  return (
    <RadioGroup
      value={theme}
      onValueChange={setTheme}
      className="flex flex-col gap-0 font-sans font-medium"
      defaultValue={theme}
    >
      <div className="flex cursor-pointer items-center space-x-2">
        <RadioGroupItem value="light" id="light" />
        <label
          className={cn(
            "ease-primary text-foreground/60 peer-data-[state=checked]:text-foreground origin-left cursor-pointer transition-all duration-700 peer-data-[state=unchecked]:-translate-x-[1.6rem]",
            className,
          )}
          data-underline-link
          htmlFor="light"
        >
          Light
        </label>
      </div>
      <div className="flex cursor-pointer items-center space-x-2">
        <RadioGroupItem value="dark" id="dark" />
        <label
          data-underline-link
          htmlFor="dark"
          className={cn(
            "ease-primary text-foreground/60 peer-data-[state=checked]:text-foreground origin-left cursor-pointer transition-all duration-700 peer-data-[state=unchecked]:-translate-x-[1.6rem]",
            className,
          )}
        >
          Dark
        </label>
      </div>
    </RadioGroup>
  );
};

export default ThemeSelector;
