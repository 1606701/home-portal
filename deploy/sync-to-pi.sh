#!/bin/bash
# 从开发机（Windows/Git Bash）把门户同步到香橙派并重启。
#
# 为什么不用板子上的 git pull：香橙派连不上 github.com:443（实测 curl 8 秒超时，
# DNS 解析正常但建立不了连接）。所以更新方向是「本机 → 板子」，
# git 只作为版本记录和备份，不再当作部署通道。
#
# 用法：
#   bash deploy/sync-to-pi.sh
#   PI=HwHiAiUser@192.168.3.185 SUDO_PASS=xxx bash deploy/sync-to-pi.sh   # 免交互
#
# 说明：SUDO_PASS 会作为环境变量出现在板子的进程列表里（仅几毫秒）。
# 在意的话就不传，让远端 sudo 交互式问你密码。
set -u

PI=${PI:-HwHiAiUser@192.168.3.185}
DIR=${DIR:-/home/HwHiAiUser/Yangfan_WorkSpace/portal}
SRC=$(cd "$(dirname "$0")/.." && pwd)

echo "===== 1. 打包 $SRC ====="
if [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null)" ]; then
  echo "  ⚠ 工作区有未提交改动，仍会同步（建议先 commit）"
fi
echo "  提交: $(git -C "$SRC" log --oneline -1 2>/dev/null || echo '非 git 仓库')"

echo "===== 2. 传输 ====="
if ! tar czf - --exclude=.git --exclude=node_modules --exclude='*.log' -C "$SRC" . \
  | ssh "$PI" 'rm -rf /tmp/portal-sync && mkdir -p /tmp/portal-sync && tar xzf - -C /tmp/portal-sync && echo "  已上传"'; then
  echo "  ✗ 上传失败（检查网络 / SSH）"
  exit 1
fi

echo "===== 3. 落盘 + 修正换行与权限 + 装 unit + 重启 ====="
# 远端脚本用 heredoc 传，避免多层引号嵌套被本地 shell 吃掉
ssh "$PI" "DIR='$DIR' SUDO_PASS='${SUDO_PASS:-}' bash -s" <<'REMOTE'
set -e

SUDO() {
  if [ -n "$SUDO_PASS" ]; then
    echo "$SUDO_PASS" | sudo -S "$@" 2>/dev/null
  else
    sudo "$@"
  fi
}

mkdir -p "$DIR"
cp -rf /tmp/portal-sync/. "$DIR"/

# Windows 工作区是 CRLF，不转成 LF 会得到 bad interpreter: /bin/bash^M
find "$DIR" -name '*.sh' -print0 | xargs -0 -r sed -i 's/\r$//'
find "$DIR" \( -name '*.service' -o -name '*.timer' \) -print0 | xargs -0 -r sed -i 's/\r$//'
chmod +x "$DIR"/deploy/*.sh
rm -rf /tmp/portal-sync
echo "  落盘完成：$(ls "$DIR" | tr '\n' ' ')"

SUDO install -m 644 "$DIR/deploy/portal.service" /etc/systemd/system/portal.service
if [ -f "$DIR/deploy/portal-watchdog.sh" ]; then
  SUDO install -m 755 "$DIR/deploy/portal-watchdog.sh"      /usr/local/bin/portal-watchdog.sh
  SUDO install -m 644 "$DIR/deploy/portal-watchdog.service" /etc/systemd/system/portal-watchdog.service
  SUDO install -m 644 "$DIR/deploy/portal-watchdog.timer"   /etc/systemd/system/portal-watchdog.timer
fi
SUDO systemctl daemon-reload
SUDO systemctl restart portal.service
SUDO systemctl enable --now portal-watchdog.timer >/dev/null 2>&1 || true
echo "  已重启 portal，看门狗 timer: $(systemctl is-active portal-watchdog.timer)"
REMOTE

if [ $? -ne 0 ]; then
  echo "  ✗ 远端部署失败"
  exit 1
fi

echo "===== 4. 健康检查 ====="
ssh "$PI" 'for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1/ 2>/dev/null)
    if [ "$code" = "200" ]; then
      echo "  HTTP 200（约 $((i * 5))00ms）"
      echo -n "  服务: "; systemctl is-active portal homebox photo-frame | tr "\n" " "; echo
      echo -n "  门户日志尾行: "; tail -1 /var/log/portal.log 2>/dev/null || echo "(暂无)"
      exit 0
    fi
    sleep 0.5
  done
  echo "  ✗ 30 秒内没起来，看 /var/log/portal.log 与 systemctl status portal"
  exit 1'

echo "===== 完成 ====="
