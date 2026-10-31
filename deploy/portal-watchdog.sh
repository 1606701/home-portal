#!/bin/bash
# portal 自愈看门狗
#
# 为什么需要它：门户跑在 80 端口，是整台板子所有服务的入口。它一旦停下，
# 你就既找不到应用入口、也看不到系统状态，而且不会有任何提示。
# systemd 的 Restart=always 救不了这种情况——手动 stop 或被判为 failed 之后，
# systemd 不会自己拉起，必须有人再 start 一次。
#
# 由 portal-watchdog.timer 每 2 分钟触发一次，以 root 运行（需要 systemctl start）。
set -u

UNIT=portal.service
URL=http://127.0.0.1/

log() {
  logger -t portal-watchdog "$*"
  echo "$*"
}

# ---- 1. 服务根本没在跑：直接拉起 ----
if ! systemctl is-active --quiet "$UNIT"; then
  log "检测到 $UNIT 未运行（当前状态：$(systemctl is-active "$UNIT" 2>/dev/null)），正在启动"
  systemctl start "$UNIT"
  sleep 3
  if systemctl is-active --quiet "$UNIT"; then
    log "启动成功，门户已恢复"
    exit 0
  fi
  log "启动失败，需要人工介入：journalctl -u $UNIT -n 50"
  exit 1
fi

# ---- 2. 进程在跑但 HTTP 不通：重试一次再决定，避免瞬时抖动导致误重启 ----
if ! curl -fsS -m 5 -o /dev/null "$URL"; then
  sleep 3
  if ! curl -fsS -m 5 -o /dev/null "$URL"; then
    log "服务在运行但 $URL 两次都无响应，重启 $UNIT"
    systemctl restart "$UNIT"
    sleep 3
    if curl -fsS -m 5 -o /dev/null "$URL"; then
      log "重启后已恢复"
      exit 0
    fi
    log "重启后仍无响应，需要人工介入"
    exit 1
  fi
fi

# 一切正常，静默退出（不写日志，免得每 2 分钟刷一遍 journal）
exit 0
