pkgname=openwork
pkgver=0.11.184
pkgrel=1 # pkgrel should change when PKGBUILD does. Standard is to change back to 1 next time. Any interger is valid.
pkgdesc="An Open source alternative to Claude Cowork"
arch=('x86_64' 'aarch64')
url="https://github.com/different-ai/openwork"
license=('MIT')
# webkit2gtk-4.1 provides both webkit2gtk-4.1.pc and javascriptcoregtk-4.1.pc
depends=('gtk3' 'glib2' 'libayatana-appindicator' 'libsoup3' 'webkit2gtk-4.1' 'openssl' 'dbus' 'librsvg')

# Architecture-specific sources and checksums
source_x86_64=("${pkgname}-${pkgver}.deb::${url}/releases/download/v${pkgver}/openwork-desktop-linux-amd64.deb")
sha256sums_x86_64=('b165c78dea8127becba79361c704580dfae406b1a3c76f47606d174cdb6b0781')

source_aarch64=("${pkgname}-${pkgver}.deb::${url}/releases/download/v${pkgver}/openwork-desktop-linux-arm64.deb")
sha256sums_aarch64=('ef0293dee00c6d71e700dadb8548f8b782fc7647f43a6a1d684d4b1dc69091de')

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
