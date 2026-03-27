import { redirect } from "next/navigation";

export default async function ManageMembersRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  redirect(`/o/${encodeURIComponent(orgSlug)}/dashboard/members`);
}
