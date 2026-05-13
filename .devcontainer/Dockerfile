# Full Electron + Den dev environment for Daytona sandboxes.
#
# Clones the repo from GitHub, installs deps, and provides
# Xvfb + noVNC so you can see/steer the real Electron app
# from your browser.

FROM node:20-bookworm

# System deps for Electron / Chromium + virtual display + utils
RUN apt-get update && apt-get install -y --no-install-recommends \
    git unzip dbus dbus-x11 \
    libgtk-3-0 libnotify-dev libnss3 libxss1 libasound2 \
    libxtst6 libatk-bridge2.0-0 libdrm2 libgbm1 libxrandr2 \
    libxcomposite1 libxdamage1 libxfixes3 libcups2 \
    libpango-1.0-0 libcairo2 \
    xvfb x11vnc novnc websockify fluxbox xterm \
    default-mysql-client \
    && rm -rf /var/lib/apt/lists/*

# pnpm + bun
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN npm install -g bun

# noVNC index
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

ENV DISPLAY=:99
ENV ELECTRON_DISABLE_SANDBOX=1
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Clone and install
ARG REPO_URL=https://github.com/different-ai/openwork.git
ARG BRANCH=dev
WORKDIR /workspace
RUN git clone --depth 1 --branch $BRANCH $REPO_URL . && pnpm install --frozen-lockfile || pnpm install

EXPOSE 3005 5173 6080 8788 9825
