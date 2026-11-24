let lastActivity = 0;
export function touchCloudComputerActivity() { lastActivity = Date.now(); }
export function cloudComputerActivityAt() { return lastActivity; }
