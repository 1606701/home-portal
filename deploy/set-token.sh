#!/bin/bash
# 生成/重置门户「一键升级」的口令，并把免密规则装到正确的位置。
# 在香橙派上以普通用户运行即可（用到 sudo 时会问密码）。
#
#   bash deploy/set-token.sh            # 生成口令（已有则保留）并装 sudoers
#   bash deploy/set-token.sh --force     # 强制换一个新口令
#   bash deploy/set-token.sh --show      # 只看当前口令
#
# 口令文件放在仓库根目录的 .upgrade-token，已在 .gitignore 里，不会被推到公开仓库。
set -eu

DIR=$(cd "$(dirname "$0")/.." && pwd)
TOKEN_FILE="$DIR/.upgrade-token"
BLOCK="$DIR/deploy/portal-upgrade.sudoers"
SUDOERS=/etc/sudoers

# 允许用 SUDO_PASS 环境变量免交互；不传就让 sudo 自己问密码
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

echo "===== 1. 口令 ====="
if [ -f "$TOKEN_FILE" ] && [ "${1:-}" != "--force" ]; then
  echo "  已有口令，保持不变（要换就加 --force）"
else
  # 24 位大小写+数字，够长也还能手输
  TOKEN=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
  umask 077
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "  已生成并写入 $TOKEN_FILE（权限 600）"
fi
echo "  口令：$(cat "$TOKEN_FILE")"

echo "===== 2. 安装自重启助手 ====="
# 门户重启自己要走「无参数 sudo 调用一个系统级脚本」这条路，
# 原因见 deploy/portal-upgrade.sudoers 里的注释。
SUDO install -m 755 -o root -g root "$DIR/deploy/portal-self-restart.sh" /usr/local/bin/portal-self-restart
echo "  已安装 /usr/local/bin/portal-self-restart"

echo "===== 3. 安装免密规则到 $SUDOERS 末尾 ====="
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/etc/sudoers.bak-$STAMP"
SUDO cp -a "$SUDOERS" "$BACKUP"
echo "  已备份到 $BACKUP"

# 先删掉旧的标记块（保证可重复执行），再把新块追加到文件最末尾——
# 必须是末尾：sudo 是「最后匹配的规则生效」，而这块板子的 /etc/sudoers
# 在 @includedir 之后还有一条 `HwHiAiUser ALL=(ALL) ALL`。
SUDO awk '/^# >>> portal-upgrade >>>$/{s=1;next} /^# <<< portal-upgrade <<<$/{s=0;next} !s' \
  "$SUDOERS" > /tmp/sudoers.new
cat "$BLOCK" >> /tmp/sudoers.new
SUDO install -m 440 -o root -g root /tmp/sudoers.new "$SUDOERS"
rm -f /tmp/sudoers.new

# 旧的 sudoers.d 版本是无效的（会被那条 ALL 覆盖），留着只会让人看糊涂
if [ -f /etc/sudoers.d/portal-upgrade ]; then
  SUDO rm -f /etc/sudoers.d/portal-upgrade
  echo "  已移除无效的 /etc/sudoers.d/portal-upgrade"
fi

echo "===== 4. 校验语法 ====="
if SUDO visudo -c >/dev/null 2>&1; then
  echo "  语法 OK"
else
  echo "  ✗ 语法有问题，正在从备份恢复"
  SUDO cp -a "$BACKUP" "$SUDOERS"
  rm -f /tmp/sudoers.new
  exit 1
fi

echo "===== 5. 确认规则排在文件末尾（这决定它是否生效）====="
SUDO grep -n "NOPASSWD\|ALL=(ALL) ALL" "$SUDOERS" | tail -4 | sed 's/^/    /'

echo
echo "完成。页面点「升级」时输入上面那串口令，输一次会记在浏览器里。"
echo "看口令：bash deploy/set-token.sh --show"
echo
echo "提醒：本脚本不去假装验证免密是否真生效（sudo -l 会给出假阳性——"
echo "它只看权限存在与否，不看最后匹配的是哪条）。真要确认就实跑一次："
echo "  sudo -n /usr/bin/systemctl restart homebox.service"
