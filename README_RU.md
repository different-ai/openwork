🌐 Языки: [English](README.md) | Русский | [简体中文](README_ZH.md) | [繁體中文](README_ZH_hk.md) | [日本語](README_JA.md)

> OpenWork — это открытая альтернатива Claude Cowork/Codex (десктопное приложение).


## Основная философия

- Локальный-first, cloud-ready: OpenWork запускается на вашей машине в один клик. Отправляйте сообщения мгновенно.
- Компонуемый: десктопное приложение, коннектор WhatsApp/Slack/Telegram или сервер. Используйте то, что подходит, без привязки.
- Извлекаемый: OpenWork работает на базе OpenCode, поэтому всё, что умеет OpenCode, работает и в OpenWork, даже без UI.
- Делиться значит заботиться: начните в одиночку на localhost, затем явно включите удалённый общий доступ, когда понадобится.

<p align="center">
  <img src="./app-demo.gif" alt="Демонстрация OpenWork" width="800" />
</p>

OpenWork разработан с идеей, что вы можете легко паковать ваши агентские рабочие процессы как воспроизводимый, продуктизированный процесс.

## Альтернативные UI
- **OpenWork Orchestrator (CLI хост)**: запускайте OpenCode + сервер OpenWork без десктопного UI.
  - установка: `npm install -g openwork-orchestrator`
  - запуск: `openwork start --workspace /path/to/workspace --approval auto`
  - документация: [apps/orchestrator/README.md](./apps/orchestrator/README.md)

## Быстрый старт

Скачайте десктопное приложение с [openworklabs.com/download](https://openworklabs.com/download), возьмите последний [релиз на GitHub](https://github.com/different-ai/openwork/releases) или установите из исходников ниже.

- Загрузки для macOS и Linux доступны напрямую.
- Доступ для Windows в настоящее время осуществляется через платный тариф поддержки на [openworklabs.com/pricing#windows-support](https://openworklabs.com/pricing#windows-support).
- Воркеры размещённые на OpenWork Cloud запускаются из веб-приложения после оформления заказа, затем подключаются из десктопного приложения через `Добавить рабочее пространство` -> `Подключить удалённое`.

## Зачем?

Текущие CLI и GUI для OpenCode ориентированы на разработчиков. Это означает фокус на диффах файлов, именах инструментов и сложно расширяемых возможностях без reliance на CLI.

OpenWork разработан, чтобы быть:

- **Расширяемым**: навыки и плагины OpenCode — это устанавливаемые модули.
- **Аудируемым**: показывает, что произошло, когда и почему.
- **Пермиссионированным**: доступ к привилегированным процессам.
- **Локальный/Удалённый**: OpenWork работает локально, а также может подключаться к удалённым серверам.

## Что включено

- **Режим хоста**: запускает OpenCode локально на вашем компьютере
- **Режим клиента**: подключение к существующему серверу OpenCode по URL.
- **Сессии**: создание/выбор сессий и отправка запросов.
- **Живой стриминг**: SSE `/event` подписка для обновлений в реальном времени.
- **План выполнения**: отображение задач OpenCode в виде таймлайна.
- **Разрешения**: отображение запросов разрешений и ответы (разрешить один раз / всегда / отклонить).
- **Шаблоны**: сохранение и повторный запуск распространённых рабочих процессов (хранятся локально).
- **Экспорт отладки**: копирование или экспорт отчёта об отладке среды выполнения и потока логов разработчика из Настройки -> Отладка при необходимости сообщить о баге.
- **Менеджер навыков**:
  - список установленных папок `.opencode/skills`
  - импорт локальной папки навыка в `.opencode/skills/<skill-name>`

## Менеджер навыков

<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />

## Работает на локальном компьютере или серверах

<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />

## Быстрый старт

### Требования

- Node.js + `pnpm`
- Rust toolchain (для Tauri): установка через `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Tauri CLI: `cargo install tauri-cli`
- OpenCode CLI установлен и доступен в PATH: `opencode`

### Локальная разработка (Десктоп)

Перед запуском `pnpm dev` убедитесь, что установлены и активны:

- Node + pnpm (репозиторий использует `pnpm@10.27.0`)
- **Bun 1.3.9+** (`bun --version`)
- Rust toolchain (для Tauri), с Cargo из текущего стабильного `rustup` (поддерживает `Cargo.lock` v4)
- Xcode Command Line Tools (macOS)
- На Linux пакеты разработки WebKitGTK 4.1, чтобы `pkg-config` мог разрешить `webkit2gtk-4.1` и `javascriptcoregtk-4.1`

### Быстрая проверка за одну минуту

Запустите из корня репозитория:

```bash
git checkout dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile

which bun
bun --version
pnpm --filter @openwork/desktop exec tauri --version
```

### Установка

```bash
pnpm install
```

OpenWork теперь находится в `apps/app` (UI) и `apps/desktop` (десктопная оболочка).

### Запуск (Десктоп)

```bash
pnpm dev
```

`pnpm dev` теперь автоматически включает `OPENWORK_DEV_MODE=1`, поэтому десктопная разработка использует изолированное состояние OpenCode вместо вашей персональной глобальной конфигурации/аутентификации/данных.

### Запуск (только Web UI)

```bash
pnpm dev:ui
```

Все точки входа `dev` репозитория теперь используют ту же изоляцию dev-режима, поэтому локальные тесты согласованно используют состояние OpenCode, управляемое OpenWork.

### Для пользователей Arch:

```bash
sudo pacman -S --needed webkit2gtk-4.1
curl -fsSL https://opencode.ai/install | bash -s -- --version "$(node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync('constants.json','utf8')); process.stdout.write(String(parsed.opencodeVersion||'').trim().replace(/^v/,''));")" --no-modify-path
```

## Архитектура (высокий уровень)

- В **режиме хоста** OpenWork запускает локальный стек хоста и подключает к нему UI.
  - Среда выполнения по умолчанию: `openwork` (устанавливается из `openwork-orchestrator`), который оркестрирует `opencode`, `openwork-server` и опционально `opencode-router`.
  - Резервная среда выполнения: `direct`, где десктопное приложение напрямую запускает `opencode serve --hostname 127.0.0.1 --port <free-port>`.

Когда вы выбираете папку проекта, OpenWork запускает стек хоста локально, используя эту папку, и подключает десктопный UI.
Это позволяет запускать агентные рабочие процессы, отправлять запросы и видеть прогресс полностью на вашей машине без удалённого сервера.

- UI использует `@opencode-ai/sdk/v2/client` для:
  - подключения к серверу
  - списка/создания сессий
  - отправки запросов
  - подписки на SSE события (Server-Sent Events используются для потоковой передачи обновлений в реальном времени с сервера на UI.)
  - чтения задач и запросов разрешений

## Выбор папки

Выбор папки использует плагин диалога Tauri.
Разрешения возможностей определены в:

- `apps/desktop/src-tauri/capabilities/default.json`

## Плагины OpenCode

Плагины — это **нативный** способ расширения OpenCode. OpenWork теперь управляет ими из вкладки «Навыки»,
читая и записывая `opencode.json`.

- **Область проекта**: `<workspace>/opencode.json`
- **Глобальная область**: `~/.config/opencode/opencode.json` (или `$XDG_CONFIG_HOME/opencode/opencode.json`)

Вы всё ещё можете редактировать `opencode.json` вручную; OpenWork использует тот же формат, что и OpenCode CLI:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## Полезные команды

```bash
pnpm dev
pnpm dev:ui
pnpm typecheck
pnpm build
pnpm build:ui
pnpm test:e2e
```

## Устранение неполадок

Если вам нужно сообщить о баге десктопа или сессии, откройте Настройки -> Отладка и экспортируйте отчёт об отладке среды выполнения и логи разработчика перед созданием issue.

### Linux / Wayland (Hyprland)

Если OpenWork падает при запуске с ошибками WebKitGTK, такими как `Failed to create GBM buffer`, отключите dmabuf или композитинг перед запуском. Попробуйте один из следующих флагов окружения.

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 openwork
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 openwork
```

## Примечания по безопасности

- OpenWork скрывает рассуждения моделей и чувствительные метаданные инструментов по умолчанию.
- Режим хоста привязывается к `127.0.0.1` по умолчанию.

## Участие в разработке

- Изучите `AGENTS.md` плюс `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md` и `ARCHITECTURE.md`, чтобы понять цели продукта перед внесением изменений.
- Убедитесь, что Node.js, `pnpm`, Rust toolchain и `opencode` установлены перед работой в репозитории.
- Запустите `pnpm install` один раз после checkout, затем проверьте изменение с помощью `pnpm typecheck` плюс `pnpm test:e2e` (или целевого подмножества скриптов) перед открытием PR.
- Используйте `.github/pull_request_template.md` при открытии PR и включите точные команды, результаты, шаги ручной проверки и доказательства.
- Если CI падает, классифицируйте сбои в теле PR как либо регрессии кода, либо внешние/окружение/аутентификация блокеры.
- Добавляйте новые PRD в `apps/app/pr/<name>.md`, следуя соглашениям `.opencode/skills/prd-conventions/SKILL.md`, описанным в `AGENTS.md`.

Документация сообщества:

- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `SUPPORT.md`
- `TRIAGE.md`

Контрольный список первого вклада:

- [ ] Запустите `pnpm install` и команды базовой проверки.
- [ ] Подтвердите, что ваше изменение имеет чёткую ссылку на issue и область.
- [ ] Добавьте/обновите тесты для поведенческих изменений.
- [ ] Включите запущенные команды и результаты в ваш PR.
- [ ] Добавьте скриншоты/видео для изменений пользовательских потоков.

## Для команд и бизнеса

Интересует использование OpenWork в вашей организации? Мы будем рады услышать от вас — свяжитесь с нами по адресу [ben@openworklabs.com](mailto:ben@openworklabs.com), чтобы обсудить ваш вариант использования.

## Лицензия

MIT — см. `LICENSE`.
