// Compatibility entry point; CI selection is owned by journeys.mjs.
import { discoverJourneys } from './journeys.mjs';
for (const entry of await discoverJourneys()) {
  if (entry.placement !== 'daytona') console.log(entry.spec);
}
