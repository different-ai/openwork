import LogoSymbolIcon from "@/icons/logos/logo-symbol";
import { cn } from "@/lib/utils";

const Eyebrow = ({
  children,
  className,
  logoClassName,
  animated: _animated = true,
  animationDelay: _animationDelay = 0
}: {
  children?: React.ReactNode;
  className?: string;
  logoClassName?: string;
  animated?: boolean;
  animationDelay?: number;
}) => {
  return (
    <div className={cn("gap-sm flex items-center", className)}>
      <LogoSymbolIcon className={cn("text-primary w-[2.2rem]", logoClassName)} />
      <p className="font-sans text-[1.4rem] font-medium uppercase tracking-[0.06em] text-foreground/70">
        {children}
      </p>
    </div>
  );
};

export default Eyebrow;
