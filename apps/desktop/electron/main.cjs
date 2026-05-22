globalThis.__OPENWORK_ELECTRON__ = require("electron");

import("./main.mjs").catch((error) => {
  console.error(error);
  process.exit(1);
});
