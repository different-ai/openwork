pkgname=openwork
pkgver=0.11.169
pkgrel=1 # pkgrel should change when PKGBUILD does. Standard is to change back to 1 next time. Any interger is valid.
pkgdesc="An Open source alternative to Claude Cowork"
arch=('x86_64' 'aarch64')
url="https://github.com/different-ai/openwork"
license=('MIT')
# webkit2gtk-4.1 provides both webkit2gtk-4.1.pc and javascriptcoregtk-4.1.pc
depends=('gtk3' 'glib2' 'libayatana-appindicator' 'libsoup3' 'webkit2gtk-4.1' 'openssl' 'dbus' 'librsvg')

# Architecture-specific sources and checksums
source_x86_64=("${pkgname}-${pkgver}.deb::${url}/releases/download/v${pkgver}/openwork-desktop-linux-amd64.deb")
sha256sums_x86_64=('32ce775a82a8cd660a31f639ce507e266f93c17e219cd4734f5cd68e5b63338e')

source_aarch64=("${pkgname}-${pkgver}.deb::${url}/releases/download/v${pkgver}/openwork-desktop-linux-arm64.deb")
sha256sums_aarch64=('e86be82bb3f3c1811bf0299ce92116a068617e0ff9d316491813831019427e8c')

# Makes sure makepkg doesn't extract the .deb since it will break
noextract=("${pkgname}-${pkgver}.deb")

package() {
  # cd cwd
  cd "${srcdir}"

  # Extract the internal data archive directly to the cwd.
  bsdtar -O -xf "${pkgname}-${pkgver}.deb" 'data.tar*' | bsdtar -C "${pkgdir}" -xf -
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
