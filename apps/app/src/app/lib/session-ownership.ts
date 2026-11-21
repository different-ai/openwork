import type { Client } from "../types";
import { unwrap } from "./opencode";
import { isOpencodeV2Client } from "./opencode-v2-adapter";

type Options = { signal?: AbortSignal };

export async function engineDirectory(client: Client, directory: string, options?: Options): Promise<string> {
  if (isOpencodeV2Client(client)) return directory;
  return unwrap(await client.path.get({ directory }, options)).directory;
}

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
