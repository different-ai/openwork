export function createDesktopTransferRegistry() {
  const active = new Map();
  const keyFor = (event, transferId) => {
    const id = typeof transferId === "string" ? transferId.trim() : "";
    if (!id || id.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(id)) {
      throw new Error("A valid transferId is required.");
    }
    return `${event.sender.id}:${id}`;
  };
  return {
    async run(event, transferId, operation) {
      const key = keyFor(event, transferId);
      if (active.has(key)) throw new Error("transferId is already active.");
      const controller = new AbortController();
      const abort = () => controller.abort();
      active.set(key, controller);
      event.sender.once("destroyed", abort);
      try {
        return await operation(controller.signal);
      } finally {
        event.sender.removeListener("destroyed", abort);
        active.delete(key);
      }
    },
    cancel(event, transferId) {
      const controller = active.get(keyFor(event, transferId));
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}
