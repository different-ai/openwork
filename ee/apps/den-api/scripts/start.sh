#!/bin/sh
# Production start (`pnpm start`). On a 4 GB instance Node's default old space is
# 2 GB, and from 2 GB up V8 lets the heap grow to about four times its live data
# between full collections. 48% of the instance's memory (1.9 GB on 4 GB) keeps
# about the same ceiling but halves that growth, and stays below Node's default
# on any size. An explicit heap size in NODE_OPTIONS wins.
# Runs from any directory, so a host can start it without a pnpm wrapper.
cd "$(dirname "$0")/.." || exit 1
case " ${NODE_OPTIONS:-} " in
  *--max-old-space-size*) exec node dist/main.js ;;
esac
exec node --max-old-space-size-percentage=48 dist/main.js
