# Bake the Ubuntu 24.04 + Docker Engine + OpenShell CLI rootfs that
# installer.mjs phaseDistro imports via `wsl --import`. We build on
# Linux (Docker) rather than spinning up WSL on a Windows GHA runner
# because:
#   1. Docker on Linux is ~10x faster, more reliable, and cheaper to run.
#   2. `wsl --import` accepts any rootfs tarball; the source doesn't
#      have to come from another WSL distro.
#   3. We avoid the rancher-desktop/distrod fragility of running WSL
#      inside Hyper-V inside a GHA Windows VM.
#
# The driver (build-openshell-rootfs.sh) runs:
#   docker build -> docker create -> docker export | gzip
# and drops the result at apps/desktop/resources/openshell/.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages the installer phases assume: ca-certificates, curl, gpg
# for adding the Docker apt repo; sudo because OpenShell's default
# `sandbox` user expects passwordless escalation for systemd service
# control; iproute2/net-tools for openshell's network probes.
#
# systemd-sysv / dbus / dbus-user-session / policykit-1 are mandatory:
# without them WSL's /init silently refuses to exec systemd as PID 1
# (it probes /sbin/init, which only exists when systemd-sysv is
# installed), the system bus never starts, systemd-logind can't run,
# `loginctl enable-linger` fails, and the user-scoped openshell-gateway
# service never comes up. The symptom is a "Connection refused on
# :17670" the desktop doctor mis-attributes to "not installed."
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dbus \
        dbus-user-session \
        gnupg \
        iproute2 \
        less \
        net-tools \
        openssh-client \
        policykit-1 \
        procps \
        sudo \
        systemd \
        systemd-sysv \
    && rm -rf /var/lib/apt/lists/*

# openssh-client is required for `openshell sandbox connect / upload /
# download / exec` — the CLI runs `ssh` and `scp` locally to reach the
# sandbox container over the supervisor SSH relay. Without it every
# operation fails with the cryptic `Error: × No such file or directory
# (os error 2)` (Rust's stringified ENOENT from a failed exec()).

# Non-root default user. Matches the OpenShell convention of
# `run_as_user: sandbox` in policy.yaml.
RUN useradd -m -s /bin/bash -G sudo banker \
    && echo 'banker ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers

# Docker Engine — same recipe installer.mjs phaseDocker runs at first
# launch, but pre-baked so banker laptops on slow/blocked corporate
# networks never have to fetch it themselves. Pinned to noble (24.04).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
    && usermod -aG docker banker \
    && rm -rf /var/lib/apt/lists/*

# OpenShell CLI — pulled from NVIDIA's published installer. The script
# drops the binary into /usr/local/bin/openshell. The repo is
# `NVIDIA/OpenShell` (the canonical one); `NVIDIA/OpenShell-Community`
# is a separate sandbox-recipes repo whose `main/install.sh` doesn't
# exist — pointing the Dockerfile at the community repo would 404.
#
# Pin OPENSHELL_VERSION so the CI rootfs and the banker laptop agree on
# which CLI surface they're testing against. Bump deliberately, not on
# every build. See apps/desktop/RELEASE-OPENSHELL.md for the bump
# procedure.
ARG OPENSHELL_VERSION=v0.0.45
RUN curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh \
        | OPENSHELL_VERSION="${OPENSHELL_VERSION}" sh

# wsl.conf — tells WSL to use systemd as PID 1 (required for
# `service docker start` and openshell's gateway pod) and pins the
# default user to `banker`.
RUN printf '[boot]\nsystemd=true\n[user]\ndefault=banker\n' > /etc/wsl.conf

# Sanity-check the binaries the installer expects, so a regression in
# the upstream OpenShell install script breaks the build here instead
# of breaking a banker laptop weeks later.
RUN which docker && docker --version \
    && which openshell && openshell --version
