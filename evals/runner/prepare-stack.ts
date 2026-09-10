import type { TestProject } from "vitest/node";
import { planSuite } from "./stack-suite.ts";

export default async function setup(project: TestProject): Promise<void> {
  // Vitest collects these paths before global setup, after filename, project,
  // changed/related selection. Do not rediscover from process.argv.
  let specifications = project.vitest.state.getPaths().flatMap(file => project.vitest.getModuleSpecifications(file));
  // Vitest applies sharding in the pool, after global setup. Use its configured
  // sequencer on the full selection before narrowing to this project.
  if (project.vitest.config.shard) {
    const Sequencer = project.vitest.config.sequence.sequencer;
    specifications = await new Sequencer(project.vitest).shard(specifications);
  }
  const files = specifications.filter(spec => spec.project === project).map(spec => spec.moduleId);
  if (files.length === 0) {
    console.error("[openwork/evals] world plan: no files selected for this project/shard; suite preparation=none");
    return;
  }
  const plan = planSuite(files, {
    pattern: project.vitest.getGlobalTestNamePattern() ?? project.config.testNamePattern,
    surface: process.env.OPENWORK_EVAL_APP_SURFACE,
  });
  console.error(plan.diagnostic);
  // The seed/environment owns isolated per-world resources and cleanup.
  // Even legacy worlds stay lazy; no shared Den/native pair or worker cache.
}
