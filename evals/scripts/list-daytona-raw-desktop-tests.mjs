// Compatibility entry point; CI selection is owned by journey-catalog.mjs.
import { catalog } from './journey-catalog.mjs';
for (const entry of await catalog()) {
  if (entry.placement !== 'daytona') console.log(entry.spec);
}
