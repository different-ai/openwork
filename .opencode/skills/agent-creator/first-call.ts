import { config } from "./load-env";

async function main() {
  void config;
  console.log("agent-creator: no credentials required.");
}

main().catch((error) => {
  console.error(error);
});
