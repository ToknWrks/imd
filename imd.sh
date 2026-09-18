#!/usr/bin/env bash
# imd.sh — manage the IMD Launchpad Terminal under pm2
#
#   ./imd.sh restart     # restart the dashboard (zero-downtime pm2 reload)
#   ./imd.sh start       # first start
#   ./imd.sh stop
#   ./imd.sh logs        # tail logs
#   ./imd.sh status
#
# Port: IMD_DASHBOARD_PORT (default 4200). Set it once in your shell, e.g.
#   export IMD_DASHBOARD_PORT=4210
# and every restart honors it.
#
# SCOPE (important on shared hosts): every command targets ONLY this app's
# processes — the APPS list below, by NAME. Never `pm2 stop all` / `restart all`:
# that would take down every other pm2 app on the box (e.g. the AgentSignal
# trader). Same rule for npm scripts — they delegate here.
set -euo pipefail
cd "$(dirname "$0")"

CMD="${1:-status}"
APPS=("imd-dashboard" "imd-watcher")

ensure_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "pm2 not found — install it: npm install -g pm2" >&2
    exit 1
  fi
}

# True if pm2 currently knows at least one of our apps.
any_registered() {
  pm2 describe "${APPS[0]}" >/dev/null 2>&1 || pm2 describe "${APPS[1]}" >/dev/null 2>&1
}

case "$CMD" in
  start)
    ensure_pm2
    pm2 start ecosystem.config.cjs
    pm2 status "${APPS[@]}"
    echo "→ http://localhost:${IMD_DASHBOARD_PORT:-4200}"
    ;;
  restart)
    ensure_pm2
    # Restart the app whether pm2 knows it yet or not:
    if any_registered; then
      pm2 restart ecosystem.config.cjs --update-env
    else
      pm2 start ecosystem.config.cjs
    fi
    pm2 status "${APPS[@]}"
    echo "→ http://localhost:${IMD_DASHBOARD_PORT:-4200}"
    ;;
  stop)
    ensure_pm2
    # Stop by name, watcher first — a dip buy mid-signing shouldn't lose its
    # dashboard connection mid-flight (dashboard is the one serving status).
    for app in "${APPS[1]}" "${APPS[0]}"; do
      pm2 stop "$APP" 2>/dev/null || true
    done
    pm2 status "${APPS[@]}" || true
    ;;
  delete)
    ensure_pm2
    for APP in "${APPS[@]}"; do
      pm2 delete "$APP" 2>/dev/null || true
    done
    ;;
  logs)
    ensure_pm2
    pm2 logs "${APPS[@]}" --lines 100
    ;;
  status)
    ensure_pm2
    pm2 status "${APPS[@]}"
    ;;
  *)
    echo "usage: $0 {start|restart|stop|delete|logs|status}" >&2
    exit 1
    ;;
esac
