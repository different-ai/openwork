import { cn } from "@/lib/utils";

const RichContentSection = ({
  title,
  id,
  className,
  children,
}: {
  title: string;
  className?: string;
  id?: string;
  children?: React.ReactNode;
}) => {
  return (
    <section id={id} className={cn("gap-lg flex flex-col", className)}>
      <h2 className="text-foreground font-serif text-[3.2rem] font-light">{title}</h2>
      <div className="gap-base flex flex-col">{children}</div>
    </section>
  );
};

export default RichContentSection;
