#!/usr/bin/env bash
# 本地编译脚本（不依赖 Docker）
# 按依赖顺序编译：packages/ui -> @openwork/app -> orchestrator/server
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  echo "[build] $*"
}

# 解析参数
BUILD_TARGET="${1:-all}"

cd "$ROOT_DIR"

build_ui_packages() {
  log "编译 @openwork/ui ..."
  pnpm --filter @openwork/ui build
}

build_app() {
  log "编译 @openwork/app ..."
  pnpm --filter @openwork/app build
}

build_orchestrator() {
  log "编译 openwork-orchestrator ..."
  pnpm --filter openwork-orchestrator build
}

build_server() {
  log "编译 openwork-server ..."
  pnpm --filter openwork-server build
}

build_orchestrator_bin() {
  log "编译 openwork-orchestrator 可执行文件 ..."
  pnpm --filter openwork-orchestrator build:bin
}

build_server_bin() {
  log "编译 openwork-server 可执行文件 ..."
  pnpm --filter openwork-server build:bin
}

case "$BUILD_TARGET" in
  all)
    log "完整编译（UI -> App -> Server -> Orchestrator）"
    build_ui_packages
    build_app
    build_server
    build_orchestrator
    log "编译完成！"
    ;;
  app)
    log "只编译前端 App"
    build_ui_packages
    build_app
    log "前端编译完成！"
    ;;
  server)
    log "只编译 Server"
    build_server
    log "Server 编译完成！"
    ;;
  orchestrator)
    log "只编译 Orchestrator"
    build_orchestrator
    log "Orchestrator 编译完成！"
    ;;
  bin)
    log "编译所有可执行文件"
    build_server_bin
    build_orchestrator_bin
    log "可执行文件编译完成！"
    ;;
  bin:server)
    build_server_bin
    log "Server 可执行文件编译完成！"
    ;;
  bin:orchestrator)
    build_orchestrator_bin
    log "Orchestrator 可执行文件编译完成！"
    ;;
  *)
    echo "用法: $0 [all|app|server|orchestrator|bin|bin:server|bin:orchestrator]"
    echo "  all            编译全部（默认）"
    echo "  app            只编译前端 App"
    echo "  server         只编译 Server"
    echo "  orchestrator   只编译 Orchestrator"
    echo "  bin            编译所有可执行文件"
    echo "  bin:server     只编译 Server 可执行文件"
    echo "  bin:orchestrator 只编译 Orchestrator 可执行文件"
    exit 1
    ;;
esac
