import { tryOpenBrowserUrl } from "../../../app/lib/browser-handoff";

export async function tryOpenBrowserAuthUrl(url: string): Promise<boolean> {
  return (await tryOpenBrowserUrl(url)).ok;
}
