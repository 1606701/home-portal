#!/bin/bash
# 由门户以 `sudo -n /usr/local/bin/portal-self-restart` 调用，延迟几秒重启门户自己。
#
# 为什么需要这个脚本，而不是直接 sudo systemctl restart portal：
#   1. sudoers 里带参数的规则极难写对——参数必须逐字匹配，
#      而且带 `=` 的参数（--on-active=3）实测根本匹配不上，报 a password is required。
#      无参数的规则没有这些坑。
#   2. 早先试过 systemd-run --unit xxx，但临时单元名会残留冲突
#      （Failed to start transient timer unit: Unit xxx.service already exists）。
#
# 为什么延迟：门户要先把这个 HTTP 响应发回浏览器，再重启自己，
# 否则前端只会看到一个连接被重置。
#
# 调用它的进程本身就在 portal.service 的 cgroup 里，重启时会被一起杀掉——
# 这没关系：systemctl 的请求已经发给 systemd 了，重启照常进行。
sleep 2
exec /usr/bin/systemctl restart portal.service
