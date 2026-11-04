import { LibrarySetupIntro } from "../../../../_components/library-setup-intro";
import { SharePluginScreen } from "../../../../_components/share-screen";

export default async function LibraryPluginSharePage({ params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params;
  return (
    <>
      <LibrarySetupIntro introKey="library.share" />
      <SharePluginScreen pluginId={decodeURIComponent(pluginId)} />
    </>
  );
}
