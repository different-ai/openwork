import { ArtifactLinkScreen } from "../_components/artifact-link-screen";
import { readArtifactLink } from "../_lib/artifact-link";

export default async function ArtifactPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[]; org?: string | string[] }>;
}) {
  return <ArtifactLinkScreen link={readArtifactLink(await searchParams)} />;
}
