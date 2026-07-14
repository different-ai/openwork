# helm-den-api-node-options — Configure Den API Node.js startup flags

1. An operator sets Den API Node.js flags in the Helm values. The rendered ConfigMap keeps them as DEN_API_NODE_OPTIONS, and the Den API deployment passes that value to Node as NODE_OPTIONS when the container starts.
