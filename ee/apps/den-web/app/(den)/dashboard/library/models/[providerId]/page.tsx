import { LibraryModelProviderScreen } from "../../../_components/library-models-ui";

export default async function LibraryModelProviderPage({ params }: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await params;
  return <LibraryModelProviderScreen providerId={decodeURIComponent(providerId)} />;
}
