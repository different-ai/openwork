# Documents dependency licenses

Checked against the resolved Documents runtime and peer dependency graph on
2026-10-16. The package's own code, theme and TypeScript integration are MIT;
see [LICENSE](LICENSE). Dependencies retain their own licenses. Preserve their
copyright and license files when distributing a bundle or container.

| Component | Resolved version | License |
| --- | --- | --- |
| `@base-ui/react` / `@base-ui/utils` | 1.4.1 / 0.2.8 | MIT |
| `@floating-ui/core` / `dom` / `react-dom` / `utils` | 1.7.5 / 1.7.6 / 2.1.8 / 0.2.11 | MIT |
| `@babel/runtime` | 7.29.7 | MIT |
| `@tanstack/react-query` / `query-core` | 5.96.2 | MIT |
| `react` / `react-dom` | 19.2.8 | MIT |
| `scheduler` | 0.27.0 | MIT |
| `reselect` | 5.1.1 | MIT |
| `use-sync-external-store` | 1.6.0 | MIT |
| `zod` | 4.3.6 | MIT |
| `lucide-react` | 0.577.0 | ISC |
| `htmlparser2` | 8.0.2 | MIT |
| `dom-serializer` | 2.0.0 | MIT |
| `domelementtype` / `domhandler` / `domutils` / `entities` | 2.3.0 / 5.0.3 / 3.2.2 / 4.5.0 | BSD-2-Clause |
| `@openwork/workbook` | workspace | Repository MIT license |

These JavaScript components are free and open source. They require no editor
subscription, commercial API, license key or paid import/export module.
This inventory covers the Documents package, not every dependency in the host
application or a separately supplied operating-system/engine image.

## Office engine: source and binary distributions differ

The engine runs as a separate WOPI service. Its source is primarily MPL-2.0,
with other free/open-source licenses on its dependencies, fonts and artwork.
The integration does not copy the engine source into this MIT package or change
its license. Distribution must retain the engine's notices and provide the
covered source under the applicable licenses.

- [Engine source license](https://github.com/CollaboraOnline/online.mirror/blob/main/COPYING)
- [Source build instructions](https://www.collaboraoffice.org/post/build-code/)
- [Upstream's fully open-source `nobrand=yes` image build](https://github.com/CollaboraOnline/online.mirror/blob/eaa2d031909488c7b9600c85c247ec05a3bd10f6/docker/README)
- [Upstream licensing terms](https://www.collaboraonline.com/terms/collabora-online-mplv2/)
- [Upstream explanation of CODE binary branding and source builds](https://forum.collaboraonline.com/t/code-binary-license/179/3)

Upstream distinguishes MPL source from vendor executable distributions and
proprietary branding/themes. Therefore the overlay Dockerfile has **no vendor
binary base-image default** and rejects installed vendor branding packages.
Supply an explicitly pinned, maintained engine image built with upstream's
documented `nobrand=yes` recipe (which upstream describes as "100% open source"),
or build the engine from open-source code and assets. Review that image's own SBOM and notices;
an image name or a successful build is not evidence of its license contents.
Paid vendor support and proprietary vendor distributions are not required by
this integration and are not included in this package.

No Microsoft fonts are distributed by this package. Font family names in the
formatting menu are document preferences; the engine can substitute installed
open-source fonts. Install only appropriately licensed fonts in the engine image.

## Host and external services

The Workbot/Den server integration under `ee/` retains OpenWork's existing
[EE license](../../ee/LICENSE), including its production-use conditions.
Client-side code is MIT under that license's client-side exception. The reusable
package can be used in another host through its provider and transport contracts.
This PR does not relicense the host application or its authentication/storage
dependencies.

Google Drive is an external service governed by Google's account/API terms.
Google credentials stay in the host server. Hosting, storage and network resources
can incur costs even when the editor software is built entirely from open source.
