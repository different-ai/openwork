export function applyV2RequestId() {
  return async (_context: unknown, next: () => Promise<void>) => {
    await next();
  };
}
