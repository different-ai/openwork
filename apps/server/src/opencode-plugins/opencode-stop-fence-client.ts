type Post = (path: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export async function assertSessionContinuation(post: Post, input: { directory?: string; sessionID: string }): Promise<void> {
  if (!input.directory) return;
  await post("/experimental/session-stop-fence/check", input, AbortSignal.timeout(15_000));
}
