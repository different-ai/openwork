FROM node:current-bookworm

WORKDIR /opt/labs

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=/opt/labs/node_modules/.bin:/root/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN node /usr/local/lib/node_modules/npm/bin/npm-cli.js install -g pnpm@10.27.0

COPY package.json /opt/labs/package.json
RUN node /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs install --prod

COPY guest-start.mjs /opt/labs/guest-start.mjs
COPY .generated/opencode /usr/local/bin/opencode

RUN mkdir -p /workspace/repo /persist/openwork
RUN chmod +x /usr/local/bin/opencode

ENV LABS_WORKSPACE_DIR=/workspace/repo
ENV LABS_STATE_DIR=/persist/openwork
ENV LABS_SERVER_PORT=8787
ENV LABS_OPENCODE_PORT=4096
ENV LABS_REMOTE_ACCESS=1

CMD ["node", "/opt/labs/guest-start.mjs"]
