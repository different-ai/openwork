pkgname=openwork
pkgver=0.18.1
pkgrel=1 # pkgrel should change when PKGBUILD does. Standard is to change back to 1 next time. Any interger is valid.
pkgdesc="An Open source alternative to Claude Cowork"
arch=('x86_64' 'aarch64')
url="https://github.com/different-ai/openwork"
license=('MIT')
depends=('gtk3' 'nss' 'alsa-lib' 'libxss' 'libxtst' 'xdg-utils' 'at-spi2-core' 'libdrm' 'libxkbcommon' 'mesa' 'dbus' 'hicolor-icon-theme')
options=(!strip)

# Architecture-specific sources and checksums
source_x86_64=("${pkgname}-${pkgver}-x64.tar.gz::${url}/releases/download/v${pkgver}/openwork-linux-x64-${pkgver}.tar.gz")
sha256sums_x86_64=('bca42bcd19f298cbd2858576b847b18acc8c67fa6097283a82a0eb4a99169859')

source_aarch64=("${pkgname}-${pkgver}-arm64.tar.gz::${url}/releases/download/v${pkgver}/openwork-linux-arm64-${pkgver}.tar.gz")
sha256sums_aarch64=('6f304d222fe60b62fd123a8583e89d3367a6301c2a602388d14ffb6d207f3a3f')

package() {
  cd "${srcdir}"

  local bundle_dir
  case "${CARCH}" in
    x86_64)
      bundle_dir="openwork-linux-x64-${pkgver}"
      ;;
    aarch64)
      bundle_dir="openwork-linux-arm64-${pkgver}"
      ;;
    *)
      echo "Unsupported architecture: ${CARCH}" >&2
      return 1
      ;;
  esac

  install -d "${pkgdir}/opt/openwork"
  cp -a "${bundle_dir}/." "${pkgdir}/opt/openwork/"

  install -d "${pkgdir}/usr/bin"
  ln -s /opt/openwork/@openworkdesktop "${pkgdir}/usr/bin/openwork"

  install -Dm644 "${pkgdir}/opt/openwork/resources/app-dist/openwork-logo-square.svg" \
    "${pkgdir}/usr/share/icons/hicolor/scalable/apps/openwork.svg"

  install -d "${pkgdir}/usr/share/applications"
  cat > "${pkgdir}/usr/share/applications/openwork.desktop" <<'EOF'
[Desktop Entry]
Name=OpenWork
Comment=Run agents, skills, and MCP workflows
Exec=openwork %U
Terminal=false
Type=Application
Icon=openwork
StartupWMClass=OpenWork
Categories=Development;Utility;
MimeType=x-scheme-handler/openwork;
EOF

  chmod 4755 "${pkgdir}/opt/openwork/chrome-sandbox"
}
