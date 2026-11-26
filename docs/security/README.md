# Security architecture review

- [Architecture, security controls and data flows](architecture-and-data-flow.md)
- [Review and artifact verification record](verification.md)
- Architecture diagram: [PNG](diagrams/architecture-data-flow.png), [SVG](diagrams/architecture-data-flow.svg), [Mermaid](diagrams/architecture-data-flow.mmd)
- Detailed alternatives (direct providers, full Cloud worker and browser edge): [PNG](diagrams/architecture-detailed.png), [SVG](diagrams/architecture-detailed.svg), [Mermaid](diagrams/architecture-detailed.mmd)
- Desktop machine-access diagram: [PNG](diagrams/desktop-machine-access.png), [SVG](diagrams/desktop-machine-access.svg), [Mermaid](diagrams/desktop-machine-access.mmd)

## Reproduce the diagrams

Install Node.js, pnpm and Chrome/Chromium, then run from the repository root:

```sh
bash docs/security/diagrams/render.sh
```

The script pins Mermaid CLI to `11.12.0` and uses the checked-in theme configuration. It runs a headless browser, not the desktop app. If Chromium is not in the default macOS Chrome location, set `PUPPETEER_EXECUTABLE_PATH` to an installed Chromium executable. The first run downloads the CLI through pnpm; it does not change workspace dependencies.

PNG and SVG files are intentional documentation deliverables, not product UI screenshots. The Markdown document contains the evidence and qualifications; the diagrams are an overview, not an exhaustive endpoint inventory or proof of production configuration.
