import Link from "next/link";

const RichContentLink = ({ href, children }: { href: string; children: React.ReactNode }) => {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary underline">
      {children}
    </Link>
  );
};

export default RichContentLink;
