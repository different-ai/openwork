/** @jsxImportSource react */
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

type SectionPlaceholderProps = {
  title: string;
  description: string;
};

/**
 * Generic placeholder for master-plan sections that don't have a dedicated
 * page yet. Uses the same empty-state treatment as the rest of the app.
 */
export function SectionPlaceholder({ title, description }: SectionPlaceholderProps) {
  return (
    <Empty variant="ghost" className="h-full">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
