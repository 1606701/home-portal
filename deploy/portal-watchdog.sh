#!/bin/bash
# portal 自愈看门狗
#
# 为什么需要它：门户跑在 80 端口，是整台板子所有服务的入口。它一旦停下，
# 你就既找不到应用入口、也看不到系统状态，而且不会有任何提示。
# systemd 的 Restart=always 救不了这种情况——手动 stop 或被判为 failed 之后，
# systemd 不会自己拉起，必须有人再 start 一次。
#
# 由 portal-watchdog.timer 每 2 分钟触发一次，以 root 运行（需要 systemctl start）。
#
# 两个设计取舍，都是踩坑换来的：
# 1. 成功标准是「HTTP 真的返回 200」，不是「systemd 说 active」。实测 systemd 判 active
#    只要 4ms，而端口真正可服务要 125ms；个别情况下（例如刚 stop 完再 start）能拖到数秒。
#    只认 is-active 会在端口还没起来时就宣布「已恢复」，等于骗自己。
# 2. 自带日志文件。这块板子的 journald 不记录任何应用日志（journalctl 只有开机那几行，
#    /var/log/syslog 也是空的），logger 写进去等于扔进黑洞。
set -u

UNIT=portal.service
URL=http://127.0.0.1/
LOG=/var/log/portal-watchdog.log
APPLOG=/var/log/portal.log
LOG_MAX=500      # 超过这个行数就裁到最近 200 行
LOG_KEEP=200

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  # 日志写不进去也不能影响自愈，所以整体容错
  { echo "$ts $*" >> "$LOG"; } 2>/dev/null || true
  logger -t portal-watchdog "$*" 2>/dev/null || true
  echo "$*"
}

trim_file() {
  local f=$1 max=$2 keep=$3 n
  [ -f "$f" ] || return 0
  n=$(wc -l < "$f" 2>/dev/null || echo 0)
  if [ "$n" -gt "$max" ]; then
    tail -n "$keep" "$f" > "$f.tmp" 2>/dev/null \
      && mv "$f.tmp" "$f" 2>/dev/null \
      || rm -f "$f.tmp" 2>/dev/null
  fi
}

# 自己的日志 + 门户自己的 stdout（systemd 用 append: 写到文件，不会自动轮转）
trim_all() {
  trim_file "$LOG" "$LOG_MAX" "$LOG_KEEP"
  trim_file "$APPLOG" 3000 1000
}

# 轮询等待 HTTP 可用，最多 $1 秒
wait_http() {
  local limit=$1 i=0
  while [ "$i" -lt $((limit * 2)) ]; do
    curl -fsS -m 3 -o /dev/null "$URL" 2>/dev/null && return 0
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

# ---- 1. 服务根本没在跑：直接拉起 ----
if ! systemctl is-active --quiet "$UNIT"; then
  state=$(systemctl is-active "$UNIT" 2>/dev/null)
  log "检测到 $UNIT 未运行（状态：$state），正在启动"
  t0=$(now_ms)
  out=$(systemctl start "$UNIT" 2>&1) || true
  [ -n "$out" ] && log "systemctl start 输出：$out"
  if wait_http 30; then
    log "启动成功，门户已恢复（从 start 到可服务 $(( $(now_ms) - t0 )) ms）"
    trim_all
    exit 0
  fi
  # 区分两种失败：进程都没起来 vs 进程在但端口不通
  if systemctl is-active --quiet "$UNIT"; then
    log "进程已启动但 $URL 在 30 秒内都没返回 200，需要人工介入：ss -lntp | grep :80"
  else
    log "启动失败，服务状态：$(systemctl is-active "$UNIT" 2>/dev/null)，需要人工介入：systemctl status $UNIT"
  fi
  trim_all
  exit 1
fi

# ---- 2. 进程在跑但 HTTP 不通：重试一次再决定，避免瞬时抖动导致误重启 ----
if ! wait_http 5; then
  if ! wait_http 5; then
    log "服务在运行但 $URL 两次都无响应，重启 $UNIT"
    t0=$(now_ms)
    out=$(systemctl restart "$UNIT" 2>&1) || true
    [ -n "$out" ] && log "systemctl restart 输出：$out"
    if wait_http 30; then
      log "重启后已恢复（从 restart 到可服务 $(( $(now_ms) - t0 )) ms）"
      trim_all
      exit 0
    fi
    log "重启后仍无响应，需要人工介入"
    trim_all
    exit 1
  fi
fi

# 一切正常：不写日志（免得每 2 分钟刷一遍），只顺手裁一下日志文件
trim_all
exit 0
