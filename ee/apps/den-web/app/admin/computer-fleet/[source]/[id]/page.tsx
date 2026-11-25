import { notFound } from "next/navigation";
import { ComputerDetailPage } from "../../../../../components/admin/computer-fleet/computer-detail-page";

export const metadata = { title: "Computer | OpenWork admin" };

export default async function AdminComputerPage({ params }: { params: Promise<{ source: string; id: string }> }) {
  const { source, id } = await params;
  if (source !== "gateway" && source !== "direct") notFound();
  const computer = decodeURIComponent(id);
  return <ComputerDetailPage key={`${source}:${computer}`} source={source} id={computer} />;
}
