// Test-only version substitution; never changes the production acceptance gate.
Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION })
