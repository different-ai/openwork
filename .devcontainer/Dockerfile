# Full Electron dev environment with virtual display + noVNC.
#
# Gives you the real Electron app running in Daytona, accessible
# through a browser via noVNC on port 6080.

FROM mcr.microsoft.com/devcontainers/javascript-node:20

# Electron / Chromium system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 \
    libnotify-dev \
    libnss3 \
    libxss1 \
    libasound2 \
    libxtst6 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgbm1 \
    libxrandr2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libcups2 \
    libpango-1.0-0 \
    libcairo2 \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    xterm \
    && rm -rf /var/lib/apt/lists/*

# noVNC setup — serves VNC over websocket on port 6080
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# Startup script that launches Xvfb + VNC + noVNC + window manager
COPY start-display.sh /usr/local/bin/start-display.sh
RUN chmod +x /usr/local/bin/start-display.sh

ENV DISPLAY=:99
ENV ELECTRON_DISABLE_SANDBOX=1
