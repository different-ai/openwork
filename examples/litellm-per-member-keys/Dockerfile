FROM node:24-alpine

WORKDIR /app
COPY provision.mjs ./provision.mjs

USER node
ENTRYPOINT ["node", "provision.mjs"]
CMD ["reconcile", "--watch"]
