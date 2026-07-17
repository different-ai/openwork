# helm-den-api-node-options — Configure Den API Node.js startup flags

1. An operator keeps the same Den API Node.js flags in the Helm values. The Den API deployment gives Node that value directly as NODE_OPTIONS, so an upgrade from an existing deployment remains valid without changing operator configuration.

2. Deployments already using denApi.env.NODE_OPTIONS keep that exact setting during the upgrade. The chart renders one direct NODE_OPTIONS value and never combines it with valueFrom.
