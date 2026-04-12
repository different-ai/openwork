#!/usr/bin/env bash
# 本地开发启动脚本（无需 Docker）
# 流程：检查依赖 → 启动 Vite 前端 → 启动 Tauri 桌面客户端
# Tauri 内部会自动管理 orchestrator，无需手动启动
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WEB_PORT="${PORT:-5173}"
VITE_PID=""
TAURI_PID=""

log() {
  echo "[dev] $*"
}

pick_free_port() {
  local preferred="$1"
  node -e "
    const net = require('net');
    const s = net.createServer();
    s.once('error', () => {
      const s2 = net.createServer();
      s2.listen(0, '127.0.0.1', () => {
        process.stdout.write(String(s2.address().port));
        s2.close();
      });
    });
    s.once('listening', () => { process.stdout.write('${preferred}'); s.close(); });
    s.listen(${preferred}, '127.0.0.1');
  "
}

wait_for_vite() {
  local port="$1"
  local max=30
  local i=0
  log "等待 Vite 就绪（端口 ${port}）..."
  while ! bash -c ">/dev/tcp/127.0.0.1/$port" 2>/dev/null; do
    sleep 1
    i=$((i+1))
    if [[ $i -ge $max ]]; then
      log "Vite 启动超时，请检查日志"
      exit 1
    fi
  done
  log "Vite 已就绪"
}

cleanup() {
  log "正在停止服务..."
  [[ -n "$TAURI_PID" ]] && kill "$TAURI_PID" 2>/dev/null || true
  [[ -n "$VITE_PID" ]] && kill "$VITE_PID" 2>/dev/null || true
  [[ -n "$TAURI_PID" ]] && wait "$TAURI_PID" 2>/dev/null || true
  [[ -n "$VITE_PID" ]] && wait "$VITE_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

# 检查 packages/ui 是否已编译，没有则先编译
if [[ ! -d "$ROOT_DIR/packages/ui/dist" ]]; then
  log "packages/ui 尚未编译，正在编译..."
  pnpm --filter @openwork/ui build
  log "packages/ui 编译完成"
fi

WEB_PORT="$(pick_free_port "$WEB_PORT")"
log "Vite 前端端口: $WEB_PORT"

# 1. 先启动 Vite 前端
(
  cd "$ROOT_DIR"
  OPENWORK_DEV_MODE=1 \
    pnpm --filter @openwork/app exec vite \
      --host 127.0.0.1 \
      --port "$WEB_PORT" \
      --strictPort
) &
VITE_PID=$!
log "Vite PID: $VITE_PID"

# 等 Vite 起来再启 Tauri，避免 Tauri 连不上 devUrl
wait_for_vite "$WEB_PORT"

# 2. 启动 Tauri 桌面客户端（内部自动管理 orchestrator）
log "启动 Tauri 桌面客户端..."
(
  cd "$ROOT_DIR"
  OPENWORK_DEV_MODE=1 \
  PORT="$WEB_PORT" \
  OPENWORK_DATA_DIR="$HOME/.openwork/openwork-orchestrator-dev" \
    pnpm --filter @openwork/desktop exec tauri dev \
      --config src-tauri/tauri.dev.conf.json \
      --config "{\"build\":{\"devUrl\":\"http://localhost:${WEB_PORT}\"}}"
) &
TAURI_PID=$!
log "Tauri PID: $TAURI_PID"

log ""
log "客户端已启动，按 Ctrl+C 停止。"
log "Vite 地址: http://127.0.0.1:$WEB_PORT"

wait "$VITE_PID" "$TAURI_PID"
