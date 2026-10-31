#!/bin/bash
# 生成/重置门户「一键升级」的口令，并装好 sudoers 规则。
# 在香橙派上以普通用户运行即可（需要用到 sudo 时会问你密码）。
#
#   bash deploy/set-token.sh            # 生成新口令
#   bash deploy/set-token.sh --show      # 只看当前口令
#
# 口令文件放在仓库根目录的 .upgrade-token，已在 .gitignore 里，
# 不会被 commit 到公开的 GitHub 仓库。
set -eu

DIR=$(cd "$(dirname "$0")/.." && pwd)
TOKEN_FILE="$DIR/.upgrade-token"
SUDOERS=/etc/sudoers.d/portal-upgrade

# 允许用 SUDO_PASS 环境变量免交互（仅本机调试方便；不传就让 sudo 自己问密码）
SUDO() {
  if [ -n "${SUDO_PASS:-}" ]; then
    echo "$SUDO_PASS" | sudo -S "$@" 2>/dev/null
  else
    sudo "$@"
  fi
}

if [ "${1:-}" = "--show" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    echo "当前口令：$(cat "$TOKEN_FILE")"
  else
    echo "还没有设置口令（升级功能未启用）"
  fi
  exit 0
fi

echo "===== 1. 生成口令 ====="
# 24 位大小写+数字，够长且能手输
TOKEN=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
umask 077
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
echo "  已写入 $TOKEN_FILE（权限 600）"
echo "  口令：$TOKEN"

echo "===== 2. 安装 sudoers 规则（只放行三条具体命令）====="
SUDO install -m 440 -o root -g root "$DIR/deploy/portal-upgrade.sudoers" "$SUDOERS"
echo "  已安装 $SUDOERS"

echo "===== 3. 校验 sudoers 语法 ====="
if SUDO visudo -c >/dev/null 2>&1; then
  echo "  语法 OK"
else
  echo "  ✗ 语法有问题，正在回滚"
  SUDO rm -f "$SUDOERS"
  exit 1
fi

echo "===== 4. 校验免密重启是否生效（不会真重启，只检查能否通过 sudo）====="
if sudo -n -l /usr/bin/systemctl restart homebox.service >/dev/null 2>&1; then
  echo "  homebox 免密重启：可以用"
else
  echo "  ✗ 免密规则没生效，检查 $SUDOERS"
fi

echo
echo "完成。在门户页面点「升级」时输入上面那串口令即可，输一次会记在浏览器里。"
echo "想看当前口令：bash deploy/set-token.sh --show"
