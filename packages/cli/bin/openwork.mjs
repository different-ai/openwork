#!/usr/bin/env node
// Node runs the TypeScript sources directly (type stripping), so there is no build step.
import { main } from "../src/main.ts"

process.exitCode = await main(process.argv.slice(2))
