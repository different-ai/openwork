export type CompareSource = { label: string; href: string };

export type CompareIcon = "cpu" | "key" | "monitor" | "users" | "cloud" | "route" | "library" | "migrate";

export type CompareCard = {
  icon: CompareIcon;
  title: string;
  link: { label: string; href: string };
};
