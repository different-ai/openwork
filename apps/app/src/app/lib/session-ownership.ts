import type { Client } from "../types";
import { unwrap } from "./opencode";
import { isOpencodeV2Client } from "./opencode-v2-adapter";

type Options = { signal?: AbortSignal };

/**
 * The directory the engine serves for a workspace path.
 *
 * OpenCode resolves the directory it is asked to open through `realpath` and
 * stamps that resolved path on every session it stores. The desktop keeps the
 * path as the workspace was added, which can still cross a symlink (macOS
 * `/var` -> `/private/var`, `/tmp` -> `/private/tmp`, a linked folder), so it
 * cannot be compared to `session.directory` by string equality. Only the engine
 * can say whether both name the same place; ownership checks compare against
 * its answer instead of the raw workspace path.
 */
export async function engineDirectory(client: Client, directory: string, options?: Options): Promise<string> {
  // The v2 preview exposes no /path route; it keeps the exact comparison.
  if (isOpencodeV2Client(client)) return directory;
  return unwrap(await client.path.get({ directory }, options)).directory;
}

/** The root and every descendant, each verified to belong to the workspace the engine serves for `directory`. */
export async function readSessionTree(client: Client, sessionId: string, directory: string, options?: Options): Promise<string[]> {
  const [root, owner] = await Promise.all([
    client.session.get({ sessionID: sessionId, directory }, options).then(unwrap),
    engineDirectory(client, directory, options),
  ]);
  if (root.id !== sessionId || root.directory !== owner) throw new Error("Could not verify the conversation's workspace.");
  const ids = [sessionId];
  for (let index = 0; index < ids.length; index += 1) {
    const children = unwrap(await client.session.children({ sessionID: ids[index], directory }, options));
    for (const child of children) {
      if (child.parentID !== ids[index] || child.directory !== owner) throw new Error("Could not verify a subtask's owner.");
      if (!ids.includes(child.id)) ids.push(child.id);
      if (ids.length > 256) throw new Error("Too many subtasks to verify safely.");
    }
  }
  return ids;
}
