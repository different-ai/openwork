pkgname=openwork
pkgver=0.11.206
pkgrel=1 # pkgrel should change when PKGBUILD does. Standard is to change back to 1 next time. Any interger is valid.
pkgdesc="An Open source alternative to Claude Cowork"
arch=('x86_64' 'aarch64')
url="https://github.com/different-ai/openwork"
license=('MIT')
# webkit2gtk-4.1 provides both webkit2gtk-4.1.pc and javascriptcoregtk-4.1.pc
depends=('gtk3' 'glib2' 'libayatana-appindicator' 'libsoup3' 'webkit2gtk-4.1' 'openssl' 'dbus' 'librsvg')

# Architecture-specific sources and checksums
source_x86_64=("${pkgname}-${pkgver}.deb::${url}/releases/download/v${pkgver}/openwork-desktop-linux-amd64.deb")
sha256sums_x86_64=('60bafb4d6e014a6f177db4c897e26952741e916360533b0599bfc39d42637c03')

source_aarch64=("${pkgname}-${pkgver}.deb::${url}/releases/download/v${pkgver}/openwork-desktop-linux-arm64.deb")
sha256sums_aarch64=('bdddb80e3564168334d14a2897abb4020feb6821e4b6f6a73abdc293892e5593')

# Makes sure makepkg doesn't extract the .deb since it will break
noextract=("${pkgname}-${pkgver}.deb")

package() {
  # cd cwd
  cd "${srcdir}"

  # Extract the internal data archive directly to the cwd.
  bsdtar -O -xf "${pkgname}-${pkgver}.deb" 'data.tar*' | bsdtar -C "${pkgdir}" -xf -

  # The upstream .deb includes /usr/bin/opencode, but the AUR package should
  # not claim the global CLI name. OpenWork uses its bundled copy under
  # /opt/openwork/ at runtime, while opencode-bin should remain the owner of
  # /usr/bin/opencode when users install the standalone CLI.
  rm -f "${pkgdir}/usr/bin/opencode"
}
# .deb Internal Structure Reference:
# └── openwork-desktop-linux-amd64.deb
#     ├── debian-binary
#     ├── control.tar.zst
#     └── data.tar.zst (Extracted to $pkgdir)
#         ├── opt/openwork/ (App files)
#         └── usr/bin/
#             ├── opencode (Terminal agent)
#             └── openwork (GUI launcher)
