> OpenWork, Claude Cowork/Codex'e açık kaynaklı bir alternatiftir (masaüstü uygulaması).


## Core Philosophy

- Yerel öncelikli, buluta hazır: OpenWork makinenizde tek tıkla çalışır. Anında mesaj gönderin.
- Birleştirilebilir: masaüstü uygulaması, Slack/Telegram bağlayıcısı veya sunucu. Size uygun olanı kullanın, bağlı kalmayın.
- Çıkılabilir: OpenWork, OpenCode tarafından desteklenir, bu nedenle OpenCode'un yapabildiği her şey OpenWork'te çalışır; henüz bir kullanıcı arayüzü olmasa bile.
- Paylaşım önemlidir: localhost'ta tek başınıza başlayın, ardından ihtiyacınız olduğunda uzaktan paylaşıma açıkça geçin.

<p align="center">
  <img src="../app-demo.gif" alt="OpenWork demo" width="800" />
</p>

OpenWork, ajanslı iş akışlarınızı takımınız için tekrarlanabilir, ürünleştirilmiş bir süreç olarak kolayca yayınlamanızı sağlayan bir fikir etrafında tasarlanmıştır.

> [!TIP]
> **[Kurumsal Plan](https://openworklabs.com/enterprise) mı arıyorsunuz?** [Satış ekibimizle bugün konuşun](https://calendar.app.google/86QpCENvhfEzDFLu5)
>
> Özellik önceliklendirmesi, SSO, SLA desteği, LTS sürümleri ve daha fazlasını içeren gelişmiş yetenekler edinin.

## Alternate UIs
- **OpenWork Orchestrator (CLI sunucusu)**: masaüstü arayüzü olmadan OpenCode + OpenWork sunucusunu çalıştırın.
  - kurulum: `npm install -g openwork-orchestrator`
  - çalıştırma: `openwork start --workspace /path/to/workspace --approval auto`
  - belgeler: [apps/orchestrator/README.md](../apps/orchestrator/README.md)

## Quick start

Masaüstü uygulamasını [openworklabs.com/download](https://openworklabs.com/download) adresinden indirin, en son [GitHub sürümünü](https://github.com/different-ai/openwork/releases) edinin veya aşağıda kaynaktan kurun.

- macOS ve Linux indirmeleri doğrudan kullanılabilir.
- Windows erişimi şu anda [openworklabs.com/pricing#windows-support](https://openworklabs.com/pricing#windows-support) adresindeki ücretli destek planı üzerinden sağlanmaktadır.
- Barındırılan OpenWork Cloud worker'ları satın alma işleminden sonra web uygulamasından başlatılır, ardından masaüstü uygulamasından `Add a worker` -> `Connect remote` ile bağlanır.

## Why

OpenCode için mevcut CLI ve GUI'ler geliştiriciler etrafında yapılandırılmıştır. Bu, dosya farkları, araç adları ve bir CLI açığa çıkarmaya dayanmadan genişletilmesi zor yeteneklere odaklanma anlamına gelir.

OpenWork şu şekilde tasarlanmıştır:

- **Genişletilebilir**: skill ve opencode plugins kurulabilir modüllerdir.
- **Denetlenebilir**: ne olduğunu, ne zaman olduğunu ve neden olduğunu gösterir.
- **İzin tabanlı**: ayrıcalıklı akışlara erişim.
- **Yerel/Uzaktan**: OpenWork yerel olarak çalıştığı gibi uzaktan sunuculara da bağlanabilir.

## What's Included

- **Sunucu modu**: opencode'u bilgisayarınızda yerel olarak çalıştırır
- **İstemci modu**: mevcut bir OpenCode sunucusuna URL ile bağlanın.
- **Oturumlar**: oturum oluşturun/seçin ve komutlar gönderin.
- **Canlı akış**: gerçek zamanlı güncellemeler için SSE `/event` aboneliği.
- **Yürütme planı**: OpenCode todolarını bir zaman çizelgesi olarak görüntüleyin.
- **İzinler**: izin isteklerini görüntüleyin ve yanıtlayın (bir kez izin ver / her zaman / reddet).
- **Şablonlar**: yaygın iş akışlarını kaydedin ve yeniden çalıştırın (yerel olarak saklanır).
- **Hata ayıklama dışa aktarımları**: hata bildirmeniz gerektiğinde Ayarlar -> Hata ayıklama bölümünden çalışma ortamı hata ayıklama raporunu ve geliştirici günlüğü akışını kopyalayın veya dışa aktarın.
- **Skills yöneticisi**:
  - kurulu `.opencode/skills` klasörlerini listeleyin
  - yerel bir skill klasörünü `.opencode/skills/<skill-name>` konumuna aktarın

## Skill Manager

<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />

## Works on local computer or servers

<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />

## Quick Start

### Requirements

- Node.js + `pnpm`
- Rust araç zinciri (Tauri için): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` ile kurun
- Tauri CLI: `cargo install tauri-cli`
- OpenCode CLI kurulu ve PATH üzerinde kullanılabilir: `opencode`

### Local Dev Prerequisites (Desktop)

`pnpm dev` komutunu çalıştırmadan önce, bunların kurulu ve kabuğunuzda aktif olduğundan emin olun:

- Node + pnpm (depo `pnpm@10.27.0` kullanır)
- **Bun 1.3.9+** (`bun --version`)
- Rust araç zinciri (Tauri için), güncel `rustup` stabil sürümünden Cargo ile (`Cargo.lock` v4'ü destekler)
- Xcode Command Line Tools (macOS)
- Linux'ta, `pkg-config`'in `webkit2gtk-4.1` ve `javascriptcoregtk-4.1` öğelerini çözebilmesi için WebKitGTK 4.1 geliştirme paketleri

### One-minute sanity check

Depo kökünden çalıştırın:

```bash
git checkout dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile

which bun
bun --version
pnpm --filter @openwork/desktop exec tauri --version
```

### Install

```bash
pnpm install
```

OpenWork artık `apps/app` (UI) ve `apps/desktop` (masaüstü kabuğu) konumlarında bulunur.

### Run (Desktop)

```bash
pnpm dev
```

`pnpm dev` artık `OPENWORK_DEV_MODE=1`'i otomatik olarak etkinleştirir, böylece masaüstü geliştirmesi kişisel genel yapılandırmanız/kimlik doğrulamanız/verileriniz yerine izole bir OpenCode durumu kullanır.

### Run (Web UI only)

```bash
pnpm dev:ui
```

Tüm depo `dev` giriş noktaları artık aynı geliştirme modu izolasyonunu seçer, bu nedenle yerel test tutarlı olarak OpenWork tarafından yönetilen OpenCode durumunu kullanır.

### Arch Users:

```bash
sudo pacman -S --needed webkit2gtk-4.1
curl -fsSL https://opencode.ai/install | bash -s -- --version "$(node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync('constants.json','utf8')); process.stdout.write(String(parsed.opencodeVersion||'').trim().replace(/^v/,''));")" --no-modify-path
```

## Architecture (high-level)

- **Sunucu modunda**, OpenWork yerel bir sunucu yığınını çalıştırır ve arayüzü ona bağlar.
  - Varsayılan çalışma ortamı: `openwork` (`openwork-orchestrator`dan kurulur), `opencode`, `openwork-server` ve isteğe bağlı olarak `opencode-router`'ı yönetir.
  - Yedek çalışma ortamı: `direct`; masaüstü uygulaması `opencode serve --hostname 127.0.0.1 --port <free-port>` komutunu doğrudan başlatır.

Bir proje klasörü seçtiğinizde, OpenWork sunucu yığınını bu klasörü kullanarak yerel olarak çalıştırır ve masaüstü arayüzüne bağlar.
Bu, ajanslı iş akışlarını çalıştırmanıza, komutlar göndermenize ve ilerlemeyi uzaktan bir sunucu olmadan tamamen makinenizde görmenizi sağlar.

- Arayüz, `@opencode-ai/sdk/v2/client` kullanarak:
  - sunucuya bağlanır
  - oturumları listeler/oluşturur
  - komutlar gönderir
  - SSE olaylarına abone olur (Sunucu Tarafından Gönderilen Olaylar, sunucudan arayüze gerçek zamanlı güncellemeleri akış için kullanılır.)
  - todoları ve izin isteklerini okur

## Folder Picker

Klasör seçici, Tauri iletişim eklentisini kullanır.
Yetenek izinleri şu dosyada tanımlanmıştır:

- `apps/desktop/src-tauri/capabilities/default.json`

## OpenCode Plugins

Plugins, OpenCode'u genişletmenin **yerel** yoludur. OpenWork artık bunları
`opencode.json` dosyasını okuyup yazarak Skills sekmesinden yönetir.

- **Proje kapsamı**: `<workspace>/opencode.json`
- **Genel kapsam**: `~/.config/opencode/opencode.json` (veya `$XDG_CONFIG_HOME/opencode/opencode.json`)

`opencode.json` dosyasını hala manuel olarak düzenleyebilirsiniz; OpenWork, OpenCode CLI ile aynı biçimi kullanır:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## Useful Commands

```bash
pnpm dev
pnpm dev:ui
pnpm typecheck
pnpm build
pnpm build:ui
pnpm test:e2e
```

## Troubleshooting

Bir masaüstü veya oturum hatasını bildirmeniz gerekirse, bir sorun bildirmeden önce Ayarlar -> Hata ayıklama bölümünü açın ve hem çalışma ortamı hata ayıklama raporunu hem de geliştirici günlüklerini dışa aktarın.

### Linux / Wayland (Hyprland)

OpenWork başlatılırken `Failed to create GBM buffer` gibi WebKitGTK hatalarıyla çöküyorsa, başlatmadan önce dmabuf veya birleştirmeyi devre dışı bırakın. Aşağıdaki ortam değişkenlerinden birini deneyin.

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 openwork
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 openwork
```

## Security Notes

- OpenWork, model akıl yürütmesini ve hassas araç meta verilerini varsayılan olarak gizler.
- Sunucu modu varsayılan olarak `127.0.0.1` adresine bağlanır.

## Contributing

- Değişiklik yapmadan önce ürün hedeflerini anlamak için `AGENTS.md` ile birlikte `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md` ve `ARCHITECTURE.md` dosyalarını inceleyin.
- Depo içinde çalışmaya başlamadan önce Node.js, `pnpm`, Rust araç zinciri ve `opencode` kurulu olduğundan emin olun.
- Her checkout'ta bir kez `pnpm install` çalıştırın, ardından bir PR açmadan önce değişikliğinizi `pnpm typecheck` ve `pnpm test:e2e` (veya hedeflenen betik alt kümesi) ile doğrulayın.
- PR açarken `.github/pull_request_template.md` dosyasını kullanın ve tam komutları, sonuçları, manuel doğrulama adımlarını ve kanıtları ekleyin.
- CI başarısız olursa, PR gövdesindeki hataları kodla ilgili gerilemeler veya dış/ortam/kimlik doğrulama engelleyicileri olarak sınıflandırın.
- Yeni PRD'leri `AGENTS.md` dosyasında açıklanan `.opencode/skills/prd-conventions/SKILL.md` kurallarını takip ederek `apps/app/pr/<name>.md` konumuna ekleyin.

Topluluk belgeleri:

- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `SUPPORT.md`
- `TRIAGE.md`

İlk katkı kontrol listesi:

- [ ] `pnpm install` ve temel doğrulama komutlarını çalıştırın.
- [ ] Değişikliğinizin net bir sorun bağlantısı ve kapsamı olduğunu doğrulayın.
- [ ] Davranışsal değişiklikler için testleri ekleyin/güncelleyin.
- [ ] PR'nizde çalıştırılan komutları ve sonuçları ekleyin.
- [ ] Kullanıcıyı ilgilendiren akış değişiklikleri için ekran görüntüsü/video ekleyin.

## Supported Languages

Çevrilmiş README'ler: [`translated_readmes/`](./README.md), İngilizce, 简体中文, 繁體中文, 日本語 ve Türkçe olarak mevcuttur.

Uygulama şu dillerde kullanılabilir:
- English (`en`)
- French (`fr`)
- Spanish (`es`)
- Catalan (`ca`)
- Brazilian Portuguese (`pt-BR`)
- Japanese (`ja`)
- Simplified Chinese (`zh`)
- Thai (`th`)
- Vietnamese (`vi`)
- Russian (`ru`)
- Turkish (`tr`)

## For Teams & Businesses

Kuruluşunuzda OpenWork kullanmakla ilgileniyor musunuz? Sizden haber almak isteriz — kullanım durumunuz hakkında konuşmak için [ben@openworklabs.com](mailto:ben@openworklabs.com) adresine ulaşın.

## License

MIT — see `LICENSE`.
