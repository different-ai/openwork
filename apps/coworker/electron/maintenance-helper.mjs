import { runMaintenanceHelper } from "./maintenance-handoff.mjs";

// Deliberately no path/operation CLI. Only a native-spawned private IPC channel
// can prepare and arm this process. Normal execution without IPC does nothing.
if (process.argv.length !== 2 || !process.connected || typeof process.send !== "function") process.exit(1);
try { await runMaintenanceHelper(); }
catch { process.exitCode = 1; }
finally { if (process.connected) process.disconnect(); }
