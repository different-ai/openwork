# Supply a pinned, unbranded engine image (upstream nobrand=yes or a source build).
# There is deliberately no vendor binary-image default; see ../THIRD_PARTY_NOTICES.md.
# Build the tiny TypeScript bridge before building this image:
# pnpm --filter @openwork/documents build:collabora-theme
ARG DOCUMENTS_EDITOR_BASE_IMAGE
FROM ${DOCUMENTS_EDITOR_BASE_IMAGE}
USER root
COPY dist/branding.js /tmp/openwork-branding.js
COPY branding.css /tmp/openwork-branding.css
COPY install-openwork-theme.sh /tmp/install-openwork-theme.sh
RUN sh /tmp/install-openwork-theme.sh /tmp/openwork-branding.js /tmp/openwork-branding.css \
    && rm /tmp/install-openwork-theme.sh
USER cool
