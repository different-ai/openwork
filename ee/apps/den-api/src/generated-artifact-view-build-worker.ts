import { parentPort, workerData } from "node:worker_threads"
import {
  buildGeneratedArtifactViewInWorker,
  type GeneratedArtifactViewCompilerInput,
} from "./generated-artifact-view-builder.js"

if (!parentPort) throw new Error("Generated Artifact view builder must run in a worker thread.")

const result = await buildGeneratedArtifactViewInWorker(workerData as GeneratedArtifactViewCompilerInput)
parentPort.postMessage(result)
