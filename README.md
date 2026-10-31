# 局域网门户（香橙派控制台）

一个页面把板子上跑的几个应用集中起来：点卡片就跳转，顺便看看内存、存储、CPU 和网络。
跑在 **80 端口**，浏览器输入 `http://192.168.3.185` 直接进。

- 零依赖：只用 Node 内置模块，`npm install` 都不用跑
- 零外网：页面不引任何 CDN / 字体 / 图标库，图标是内联 SVG
- 手机优先：单列布局，宽屏自动两列；iPhone 底部安全区也留了

```
portal/
  server.js              HTTP 服务 + 状态采集（唯一需要懂的文件）
  config.json            应用清单，加第三个应用只改这里
  public/index.html      页面骨架
  public/style.css       样式（暖木陶土，和 HomeBox 一套）
  public/app.js          前端逻辑（轮询 / 渲染 / 降级）
  public/favicon.svg     图标
  deploy/portal.service          systemd unit
  deploy/portal-watchdog.*       看门狗（每 2 分钟自愈，见下文）
  deploy/sync-to-pi.sh           开发机 → 板子 的一键部署脚本
  README.md                      本文件
```

## 一、部署（在香橙派上）

假设代码放在 `/home/HwHiAiUser/Yangfan_WorkSpace/portal`（和 HomeBox 并排）。

```bash
# 0. 先确认 node 装在哪（unit 里写的是 /usr/bin/node，路径不同要改 ExecStart）
command -v node          # 输出不是 /usr/bin/node 的话，改 deploy/portal.service 里的 ExecStart
node -v                  # 需要 >= 18（用到了 fs.statfsSync，Node 18.15+）

# 1. 放代码
cd /home/HwHiAiUser/Yangfan_WorkSpace
# 从开发机拷过来，或 git clone，目录名保持 portal

# 2. 先手动验一遍（不需要 root，先用 8090 试）
cd /home/HwHiAiUser/Yangfan_WorkSpace/portal
PORT=8090 node server.js
# 另开一个终端：
curl -s http://127.0.0.1:8090/api/stats | head -c 400
# 浏览器：http://192.168.3.185:8090

# 3. 确认没问题再上 80 端口
sudo cp deploy/portal.service /etc/systemd/system/portal.service
sudo systemctl daemon-reload
sudo systemctl enable --now portal
sudo systemctl status portal --no-pager

# 4. 打开
# 浏览器：http://192.168.3.185
```

### 80 端口为什么不用 root

`deploy/portal.service` 里这两行让非 root 用户也能绑 80：

```ini
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

Ubuntu 22.04 的 systemd 249 支持这两个键。

**如果 `systemctl status portal` 报 `EACCES` / `Permission denied`**（说明这条没生效），按顺序降级：

1. 先确认内核允许非 root 绑低端口：
   ```bash
   sysctl net.ipv4.ip_unprivileged_port_start      # 0 就表示允许
   # 不是 0 的话： sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0
   # 持久化： echo 'net.ipv4.ip_unprivileged_port_start=0' | sudo tee /etc/sysctl.d/90-portal.conf
   ```
2. 还是不行就**换端口**，别为了 80 去用 root：
   ```bash
   sudo sed -i 's#^ExecStart=.*#ExecStart=/usr/bin/env PORT=8080 /usr/bin/node server.js#' /etc/systemd/system/portal.service
   sudo systemctl daemon-reload && sudo systemctl restart portal
   # 访问 http://192.168.3.185:8080
   ```

### 查看日志

```bash
tail -50 /var/log/portal.log        # 门户自己的输出
tail -50 /var/log/portal-watchdog.log   # 看门狗的动作用（正常时一行都不写）
```

**不要用 `journalctl -u portal`**：这块板子的 journald 不记录任何应用日志
（连 `logger` 写进去都查不到，`/var/log/syslog` 也是空的），所以 `portal.service` 里
用 `StandardOutput=append:/var/log/portal.log` 把输出直接落到文件，由看门狗每 2 分钟裁剪。

正常启动长这样：

```
门户已启动，监听 0.0.0.0:80
  本机访问： http://127.0.0.1
  局域网：  http://192.168.3.185
  网卡：    wlan0  应用：2 个
  采样器：  CPU/网络/磁盘 已预热；NPU 已识别 310B4；服务健康 5 个失败
```

最后一行是预热结果。CPU / 网络 / 磁盘这三项要现采两次（间隔 120ms）才有 delta，
放在启动时做掉，第一个 `/api/stats` 就不用替启动过程付账。
NPU / 失败服务这两项会等首轮采完（`npu-smi` 一次约 470ms）再打，所以这行会晚半秒出现。
三种状态是分开的，别混：`已识别 310B4` / `未检测到`（真没这硬件）/ `首轮采样未完成`。

### 更新代码

**更新方向是「开发机 → 板子」，不是「板子上去 pull」。**

香橙派连不上 GitHub：`getent hosts github.com` 能解析出 IP，但 `curl https://github.com/`
8 秒超时，`git pull` 会卡到 130 秒后报 `Connection timed out`。所以 git 在这里只当版本记录和备份，
部署走局域网。在开发机（Windows / Git Bash）上：

```bash
cd /d/yangf_file/portal
git add -A && git commit -m '...'      # 先留版本
git push                                # 备份到 GitHub（见下方「推送常失败」）
bash deploy/sync-to-pi.sh               # 打包 → 传输 → 落盘 → 装 unit → 重启 → 健康检查
```

`sync-to-pi.sh` 做四件事，都是有原因的：

1. `tar` 打包并排除 `.git` / `node_modules`（板子上的 `.git` 保持原样，不动它）。
2. 落盘后 `sed -i 's/\r$//'`：Windows 工作区是 CRLF，不转会在板子上变成
   `bad interpreter: /bin/bash^M`。仓库里另有 `.gitattributes` 强制 `eol=lf` 兜底。
3. 重装 `deploy/*.service|timer` 并 `daemon-reload`——改了 unit 忘了 reload 是最常见的坑。
4. `restart portal` 后轮询 `http://127.0.0.1/` 直到 200，最多等 30 秒。

只改 `config.json` 的应用清单**不需要重启**（每次请求现读）；改了 `server.js` 或 `public/` 下任何文件必须重启，
`sync-to-pi.sh` 会自动重启。

**推送常失败**：本机到 `github.com:443` 也经常连不上（DNS 解析出来的 IP 被挡）。
能用的办法是钉一个当下可连的 IP：

```bash
git -c http.curloptResolve=github.com:443:20.205.243.166 push
```

可用的 IP 会变，`20.205.243.166` 和 `140.82.112.3` 都成功过也失效过。推不上去不影响部署——
`sync-to-pi.sh` 走局域网，跟 GitHub 无关。

### 看门狗（为什么必须有）

门户挂在 80 端口，是整台板子的入口。它一旦停下，你既找不到应用入口、也看不到系统状态，
而且不会有任何提示。`Restart=always` 只管「进程崩了」——**手动 stop 或被判 failed 之后，
systemd 不会自己拉起**，必须有人再 `start` 一次。

`deploy/portal-watchdog.{sh,service,timer}` 每 2 分钟检查一次：

- 没在跑 → `start`
- 在跑但 HTTP 两次都不通（中间隔 5 秒）→ `restart`（避免瞬时抖动误重启）
- 一切正常 → 静默退出，不写日志

**成功标准是「HTTP 真的返回 200」，不是「systemd 说 active」。** 这两件事差得很远：
实测 systemd 判 active 只要 4ms，端口真正可服务要 125ms；冷启动（刚 stop 完再 start）
实测 3.6 秒。第一版看门狗用固定 `sleep 3` 判断，正好卡在 3.6 秒之下，于是把
「已在恢复中」误报成「启动失败」——现在改成轮询 HTTP，最多等 30 秒。

**看门狗和一键升级会短暂打照面。** 门户升级自己时端口会空约 7 秒，而看门狗每 2 分钟查一次。
撞上了也不要紧：那 7 秒里 unit 处于 `activating`，看门狗走的是「没在跑 → start」分支，
`start` 对正在自动重启的 unit 是空操作，接着它轮询 HTTP 直到 200。
实测多次升级没有触发误 `restart`（`/var/log/portal-watchdog.log` 零新增）。
万一真撞上 `restart`，代码其实已经合并完了，刷新页面即可，不会丢东西。

安装：

```bash
sudo install -m 755 deploy/portal-watchdog.sh      /usr/local/bin/portal-watchdog.sh
sudo install -m 644 deploy/portal-watchdog.service /etc/systemd/system/
sudo install -m 644 deploy/portal-watchdog.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now portal-watchdog.timer
```

验证它真的会救（两条路径都要验，因为它们是两段不同的代码）：

```bash
# A. 服务被停掉
sudo systemctl stop portal
sudo systemctl start portal-watchdog          # 手动触发，不用等满 2 分钟
cat /var/log/portal-watchdog.log             # 应有「检测到 portal.service 未运行」+「启动成功…XXXX ms」

# B. 进程活着但不响应：冻住它，模拟卡死
sudo kill -STOP $(systemctl show -p MainPID --value portal)   # 注意是 SIGSTOP，不是 kill
sudo systemctl start portal-watchdog
cat /var/log/portal-watchdog.log             # 应有「两次都无响应，重启」+「重启后已恢复」
```

实测记录（2026-10-31）：

| 场景 | 结果 |
| --- | --- |
| 手动 stop 后触发 | 检测到 inactive → start → 3622ms 后可服务 |
| SIGSTOP 冻住进程后触发 | HTTP 两次无响应 → restart → 611ms 后恢复 |
| 之后连续运行 2 小时（约 60 次检查） | 0 次误重启，日志零增长 |

## 二、版本对比与一键升级

页面上有一块「版本与升级」，列出三个项目当前跑的是哪个提交、镜像里有没有更新的，
有就列出来待升级的提交，点一下按钮就合并代码并重启对应服务。

**升级来源不是 GitHub，是板子上的镜像。** 因为板子连不上 `github.com:443`
（`getent hosts` 能解析，但 `curl` 8 秒超时，`git pull` 卡 130 秒后 `Connection timed out`）。
所以流程反过来：

```
开发机  ──git push mirror main──▶  板子 ~/Yangfan_WorkSpace/git-mirror/*.git（bare 镜像）
                                          │
页面点「升级」 ──git fetch + merge --ff-only──┘  ──▶  systemctl restart 对应服务
```

好处是「检查有没有新版本」和「升级」都是板子本地文件操作，**完全不依赖外网**，
你什么时候推、板子什么时候就能升。

### 发布一个新版本

在开发机上：

```bash
cd /d/yangf_file/portal          # 或 HomeBox、photo-frame
git add -A && git commit -m '...'
git push mirror main             # ← 这一步就是「发布」，板子立刻能看到有新版本
```

`mirror` 远端指向板子的 bare 镜像。三个项目都配好了：

| 项目 | 工作目录（板子） | 镜像 | systemd 单元 |
| --- | --- | --- | --- |
| 门户 | `~/Yangfan_WorkSpace/portal` | `git-mirror/home-portal.git` | `portal.service` |
| 家庭收纳 | `~/Yangfan_WorkSpace/HomeBox` | `git-mirror/HomeBox.git` | `homebox.service` |
| 电子相框 | `~/Yangfan_WorkSpace/photo-frame` | `git-mirror/photo-frame.git` | `photo-frame.service` |

想把镜像也推到 GitHub 备份就额外 `git push origin main`（GitHub 经常连不上，见「更新代码」）。

### 页面上升级

1. 列表里出现「落后 N 个提交」，还会列出这几条提交的标题，看清楚点的是什么；
2. 第一次点「升级」要输入口令，输对了会记在浏览器里，之后不用再输；
3. 合并完成会自动重启对应服务，门户升级自己时会延迟 3 秒重启并自动刷新页面。

口令在板子上生成：

```bash
cd ~/Yangfan_WorkSpace/portal
bash deploy/set-token.sh          # 生成/重置口令，并装好 sudoers 规则
bash deploy/set-token.sh --show    # 查看当前口令
```

口令存在仓库根目录的 `.upgrade-token`（权限 600，已 gitignore），**不在 config.json 里**
——这个仓库是公开的，凭据不能进版本库。没设置口令时升级接口返回 503，按钮直接不显示，
不存在「没口令就放行」这种默认。

### 四条安全底线

1. **只做 `merge --ff-only`**，不做 rebase / reset：升级不改写历史，也不丢提交。
2. **工作区有未提交改动就拒绝**，本地有未推送提交也拒绝：不覆盖你手改的东西。
   判定只看**已跟踪文件**（`git status --porcelain --untracked-files=no`）——
   未跟踪的临时文件不会被 ff 合并覆盖，不该因为它把升级永久锁死。
3. **HomeBox 的 `data/` 不在版本库里**（`.gitignore` 里有 `data/`，`git ls-files data/` 为空），
   所以 ff 合并碰不到物品数据和照片。升级前后拿四个计数一比对就能确认。
4. **sudoers 只放行两条命令**（homebox / photo-frame 的 restart），不给 `NOPASSWD: ALL`。
   门户重启自己走「进程退出 + Restart=always」，根本不需要 sudo。
   门户是个没有登录的局域网页面，靠一个口令守着升级入口，真出事也只波及这三个服务。
   为了让这两条规则真正生效，`portal.service` 不能设 `NoNewPrivileges` 和
   `CapabilityBoundingSet`——原因见下文「为什么 portal.service 里没有 NoNewPrivileges」。

### 免密规则为什么写在 /etc/sudoers 末尾，而不是 /etc/sudoers.d/

这是踩出来的坑，值一条：这块板子的 `/etc/sudoers` 长这样：

```
54: @includedir /etc/sudoers.d
55: HwHiAiUser ALL=(ALL) ALL      ← 厂商加的，在 include 之后
```

sudo 的规则是**最后匹配的那条生效**。所以放 `/etc/sudoers.d/portal-upgrade` 里的
`NOPASSWD` 会被第 55 行那条 `ALL` 覆盖，表现为：

```
$ sudo -n /usr/bin/systemctl restart homebox.service
sudo: a password is required
```

而且 `sudo -l` 会给出**假阳性**——它只回答「有没有权限」，不回答「最后匹配的是哪条」，
所以 `sudo -l /usr/bin/systemctl restart homebox.service` 返回 0 但实际执行照样要密码。
`deploy/set-token.sh` 因此把规则追加到 `/etc/sudoers` **最末尾**（用
`# >>> portal-upgrade >>>` 标记块，可重复执行），并且不再假装验证免密是否真生效。

要自己确认，就跑一次真的：

```bash
sudo -n /usr/bin/systemctl restart homebox.service && echo 免密可用
```

### 门户怎么重启自己

这里连着踩了四个坑，最后落到最朴素的办法上：

1. **`systemd-run` + 带参 sudo 规则**：失败。sudoers 的带参规则必须逐字匹配，
   带 `=` 的参数（`--on-active=3`）实测匹配不上，报的还是 `a password is required`，极难定位；
   换成空格分隔能匹配了，又撞上临时单元名残留
   （`Failed to start transient timer unit: Unit xxx.service already exists`）。
2. **无参数调用一个系统级脚本**：SSH 里手测 `sudo -n /usr/local/bin/portal-self-restart` 成功，
   但从门户进程里调一律失败。
3. 原因查到了：`portal.service` 里的 **`NoNewPrivileges=true`** 禁止 sudo 提权。
4. 最终不需要任何权限：**门户升级完自己后直接让进程退出，由 `Restart=always` 拉起新代码**。
   配合 `StartLimitIntervalSec=0`（关掉启动频率限制），连续升级也不会被 systemd 锁住。

代价是：如果某次拉下来的代码本身起不来，它会每 3 秒重启一次、一直循环，页面打不开。
所以升级前先看「待升级的提交」是什么，别把没验证过的代码推上去。
真要救回来，SSH 上去 `git reset --hard HEAD~1` 就行。

### 为什么 portal.service 里没有 NoNewPrivileges

同一块石头绊了两次，所以单独写一节。

门户要重启 homebox / photo-frame，用的是 `sudo -n /usr/bin/systemctl restart <unit>`。
这条路要求 `portal.service` 里**同时满足**两条，缺一不可：

| 配置项 | 设成限制值会怎样 |
| --- | --- |
| `NoNewPrivileges=true` | sudo 直接拒绝：`The "no new privileges" flag is set, which prevents sudo from running as root` |
| `CapabilityBoundingSet=CAP_NET_BIND_SERVICE` | sudo 拿不到 `CAP_SETUID`/`CAP_SETGID`，切 root 时失败 |

这两项都是妥妥的安全加固，但都会让「一键升级」永久失败。**最坑的地方是：
从 SSH 里手测 `sudo -n ... restart homebox` 返回 0，一切正常；只有从门户进程里调才失败。**
因为这个差异，我先后两次把「SSH 手测通过」当成验证完成，实际都是假的。
判断这类问题不要看命令返回码，要看 `/proc/<MainPID>/status` 里的 `NoNewPrivs` 和 `CapEff`。

现在 `portal.service` 里是 `NoNewPrivileges=false`，也没有 `CapabilityBoundingSet`。
安全性靠 `/etc/sudoers` 末尾那两条 NOPASSWD 规则兜底——门户能做的仍然只有
「重启 homebox」「重启 photo-frame」这两件事，没有 `NOPASSWD: ALL`。

如果哪天想更严格，可行的方向是按 unit 细化的 polkit 规则；
但这块板子装的是 polkit **0.105**，只支持 `.pkla`，而 `.pkla` 无法限定到具体 unit，
那样等于把这台机器上所有服务的启停权都交出去，比现在更宽，所以没有采用。

### 升级出问题怎么查

```bash
# 页面报错信息会直接说原因（口令错 / 工作区脏 / 拉取失败 / 合并失败）
cd ~/Yangfan_WorkSpace/portal && git status && git log --oneline -3
cat /var/log/portal.log                    # 服务端日志
sudo systemctl status portal homebox photo-frame
```

镜像坏了（比如误删）就重建：在开发机上 `git push mirror main --force`。
`git fetch` 只更新远端跟踪分支，不会动工作区，所以什么时候 fetch 都安全。

## 三、加/改应用

只改 `config.json`，**不用重启**（每次请求都现读，读坏了继续用上一份好的）：

```json
{
  "title": "香橙派 · 控制台",
  "backup": {
    "label": "家庭收纳备份",
    "dir": "/home/HwHiAiUser/Yangfan_WorkSpace/HomeBox/data/backup"
  },
  "apps": [
    { "id": "homebox", "name": "家庭收纳", "desc": "找东西、记一件、衣柜推荐",
      "port": 8888, "accent": "#B4633A" },
    { "id": "photo-frame", "name": "电子相框", "desc": "照片自动播放",
      "port": 9999, "accent": "#6B7F5E" }
  ]
}
```

- `id` 必填且唯一（前端拿它对应卡片节点）
- `port` 必填，必须是数字
- `accent` 是**这张卡片左侧那条色带**的颜色，随便挑
- 缺 `name` 会退回用 `id`，缺 `desc` 就是空一行，不会报错
- `backup` 是可选的：配了才显示「备份」卡。`dir` 指向备份目录，
  服务端读该目录里**最新的那个文件**的 mtime 当作「最近一次备份」，
  超过 30 小时卡片变黄（说明每天 03:00 的定时任务可能断了）。不配或目录空 → 整张卡不显示。

## 四、接口

### `GET /api/apps`

应用清单（不含实时状态），首屏渲染用。

```json
{ "ok": true, "title": "香橙派 · 控制台",
  "apps": [ { "id": "homebox", "name": "家庭收纳", "desc": "…", "port": 8888, "accent": "#B4633A" } ] }
```

### `GET /api/stats`

一次拿全。**这个接口前端每 3 秒轮询一次，所以只做便宜的事（三次 /proc 读 + 一次 TCP 探活），
贵的数据全部读后台采样器的内存快照**（见下面「为什么这么做」第 9 条）。

```json
{
  "ok": true,
  "host": { "hostname": "orangepi", "distro": "Ubuntu 22.04.3 LTS",
            "kernel": "5.10.0-…", "uptimeSec": 123456 },
  "cpu":  { "cores": 4, "usagePct": 6.1, "perCore": [12.3, 4.1, 7.8, 0.2] },
  "mem":  { "totalBytes": 7912181760, "usedBytes": 1733283840,
            "availableBytes": 6178897920, "usedPct": 21.9 },
  "disk": { "path": "/", "totalBytes": 503584522240, "usedBytes": 21474836480,
            "freeBytes": 482109685760, "usedPct": 4.3,
            "readBytesPerSec": 0, "writeBytesPerSec": 12288 },
  "net":  { "iface": "wlan0", "ipv4": "192.168.3.185", "state": "up",
            "rxBytesPerSec": 18342, "txBytesPerSec": 2048,
            "rxTotalBytes": 881234567, "txTotalBytes": 23456789 },
  "npu":  { "available": true, "chip": "310B4", "health": "Alarm", "powerW": 0,
            "tempC": 46, "aicorePct": 0, "memUsedMB": 2682, "memTotalMB": 7545,
            "faultyChips": 0, "stale": false },
  "health": { "checked": true, "failedUnits": ["vncserver@1.service", "whoopsie.service"] },
  "top":  [ { "comm": "python3", "rssBytes": 171304000 },
            { "comm": "Xorg", "rssBytes": 133404000 } ],
  "backup": { "label": "家庭收纳备份", "lastAt": "2026-10-30T03:00:14+08:00", "ageHours": 21.2 },
  "apps": [ { "id": "homebox", "name": "家庭收纳", "port": 8888, "up": true,
              "latencyMs": 3, "rssBytes": 109560000, "uptimeSec": 956000 } ]
}
```

**取不到的一律是 `null`**（不是 `false`、不是 `{}`），前端靠 `null` 显示「—」：

| 字段 | 什么时候 null |
| --- | --- |
| `cpu.usagePct` / `cpu.perCore` | 读不到 `/proc/stat`（非 Linux） |
| `mem` | 读不到 `/proc/meminfo`（非 Linux） |
| `disk.readBytesPerSec` / `writeBytesPerSec` | 读不到 `/proc/diskstats`，或没有 `nvme0n1` 这块盘 |
| `npu` | 两种情况都是 `null`：① 没有 `/usr/local/sbin/npu-smi`（真的没这块 NPU）；② 命令在、但输出解析不出来（型号行/显存行缺一）。页面都显示「未检测到 NPU」，日志里有 `[npu] 采样失败` 的才是第二种 |
| `health.checked` | 不是 null，是布尔。`false` = `systemctl` **从没成功执行过一次**（不存在 / spawn 失败 / 退出码非 0 且 stdout 为空），此时 `failedUnits` 必然是空数组，但那是「不知道」不是「0 个」 |
| `health.failedUnits` | 不会是 null，最差是空数组。**空数组要和 `checked` 一起看**：`checked:true` + `[]` 才是真的全部正常 |
| `top` | 不会是 null，最差是空数组 |
| `backup` | config.json 没配 backup，或目录不存在 / 为空 |
| `apps[].rssBytes` / `uptimeSec` | `ss -lntp` 取不到这个端口对应的 pid |

`npu.stale = true` 表示最近一次采样失败了，页面上显示的是上一次成功的值。

### `GET /api/versions`

版本对比。对 `config.json` 里的 `self` 和每个配了 `dir` 的 `apps` 跑一遍 git：
`git fetch`（只更新远端跟踪分支，不动工作区）→ 当前提交 / 镜像提交 / `behind` / `ahead` /
是否脏 / 待升级提交列表。结果缓存 10 秒，升级成功后缓存会被主动打掉。

```json
{ "ok": true, "hasToken": true,
  "list": [ { "id": "homebox", "name": "家庭收纳", "managed": true,
              "current": { "short": "b5b28d9", "subject": "…", "date": "2026-10-30T23:42:12+08:00" },
              "mirror":  { "short": "b5b28d9", "subject": "…", "date": "…" },
              "behind": 0, "ahead": 0, "dirty": false,
              "pending": [], "fetched": true, "error": null } ] }
```

`hasToken` 是「服务端配没配升级口令」，前端据此决定要不要显示升级按钮。

### `POST /api/upgrade`

```json
{ "id": "homebox", "token": "…" }
```

顺序：校验口令 → 重探一次版本（不信缓存）→ 拒绝脏工作区 / 未推送提交 / 已是最新
→ `git merge --ff-only` → 重启对应 unit。只有这一个接口会改磁盘，所以只收 POST。

| 状态码 | 含义 |
| --- | --- |
| 200 | 已升级并重启（`already: true` 表示本来就是最新） |
| 202 | 门户升级自己：已合并，进程即将退出、由 systemd 拉起新代码，页面需自动刷新 |
| 400 | 应用不存在或没配 `unit`，或未纳管版本 |
| 401 | 口令不对 |
| 409 | 已跟踪文件有未提交改动 / 本地有未推送提交 |
| 502 | 拉取镜像失败 |
| 503 | 服务端还没设置口令，功能未启用 |

### 静态文件

`GET /` → `public/index.html`；`/style.css`、`/app.js`、`/favicon.svg` 直接发。
只发 `public/` 下的文件，`..` 和畸形编码一律 404。

## 五、为什么这么做（改代码前先看这几条）

这几条都是**在这块板子上实测过**的，不是通用最佳实践：

1. **内存用 `MemTotal - MemAvailable`，不用 `MemFree`。**
   Linux 会把文件缓存算进"可用"，用 `MemFree` 会显示 90% 已用，纯属吓人且不准。

2. **不展示 load average。**
   这块板子上 `load` 常年 17 左右，看着像满载；但那 17 是固件留下的内核线程常年挂 D 状态造成的假负载，
   `top` 实测 94% idle。展示 load 等于撒谎，所以只给 `/proc/stat` 两次采样算出来的真实占用率。

3. **不做 CPU 温度。**
   `/sys/class/thermal` 是空的，这块板子没有可读的温度传感器。做了也只能显示「—」。

4. **网卡动态挑，不写死 `eth0` / `wlan0`。**
   当前只有 `wlan0` 是 UP 且有 IPv4（`eth0`、`bond0` 都 DOWN）。
   代码用 `os.networkInterfaces()` 找「非 internal、有 IPv4、不是 127.0.0.1」的第一块，换网段/插网线都不用改。

5. **CPU 与网络速率都是「两次采样取 delta」。**
   第一次请求没有历史采样，现场隔 120ms 采两次补一个 delta；
   之后每次请求拿"距上次采样"的差值，所以页面显示的是**最近约 3 秒的平均值**，不是瞬时值。
   多次请求并发时只采一次（in-flight 合流），CPU/网络各有 900ms 缓存 —— 多个页面同开也不会把板子拖垮。
   `cpu.perCore` 是 `/proc/stat` 的 `cpu0..cpuN` 逐核 delta，**长度恒等于 `cpu.cores`**：
   两者来源不同（前者 `/proc/stat`、后者 `os.cpus()`），个别容器里可能对不上，
   所以汇总时多的截掉、少的补 `null`，前端靠下标画「核0 核1 …」，条数必须对得齐。

6. **应用在线状态是 `net.connect` 探 `127.0.0.1:<port>`**，800ms 超时，全部**并发**探（串行的话两个离线应用要等 1.6 秒）。
   只做 TCP 握手，不发 HTTP 请求，对被探测的服务没有任何副作用。结果缓存 2 秒。

7. **前端不带任何外链。** 板子可能没外网，字体和图标全部走系统字体 + 内联 SVG。

8. **页面里的跳转地址用 `location.hostname` 现拼**，不写死 IP —— 换个网段（192.168.1.x）照常能用。

9. **超过 5ms 的数据源一律「后台定时采样 + 读内存快照」，绝不进请求路径。**
   `/api/stats` 每 3 秒被轮询一次，实测耗时必须压在 50ms 以内。实测成本：
   `npu-smi info` **469ms**、`systemctl --failed` 约 100ms、`ps` 约 10ms，这三个全走采样器：

   | 采样器 | 周期 | 数据源 |
   | --- | --- | --- |
   | npu | 20s | `npu-smi info`（+ `-t board` 取故障芯片数） |
   | health | 30s | `systemctl --failed --no-legend --no-pager` |
   | top | 10s | `ps -eo rss,comm --sort=-rss` |
   | procs | 10s | `ss -lntp` + `/proc/<pid>/status`、`/proc/<pid>/stat` |
   | backup | 60s | 备份目录 readdir + stat |

   采样器启动时**立刻跑一轮**（首屏不空着），定时器 `unref()`（不拖住进程退出），
   每个源独立 try/catch：某个源抛错只把该源标 `stale` 并保留上一次的值，
   不影响别的源，也不会让进程崩；上一次没跑完就跳过这一轮，不堆积。
   错误日志只在错误信息变化时打一次，避免一个坏源每 20 秒刷一遍 journal。

10. **`npu-smi info` 的输出按内容定位，不按固定列号切。**
    它是一张带大量 `+---` 和 `|` 的表格，列宽随版本变。解析时按 `|` 切、trim，
    用「第一格是『槽位 + 型号』」定位型号行，用「某格形如 `a / b`」定位显存行。
    **型号和显存两行缺一不可**，缺任何一行就整个 `npu` 返回 `null` —— 半张表会显示成
    「型号 310B4、显存 —」，看起来像板子坏了，不如不显示。

11. **NPU 的 `health: "Alarm"` 用灰色小字写，不做红灯、不加警示图标。**
    实测 `Faulty Chip Count = 0`、功耗 0W、AICore 0%，大概率是空载常态但没法确认；
    做成红灯会让人天天看到而麻木，真出问题时反而没人注意。

12. **磁盘读写固定看 `nvme0n1`，不看分区行。**
    根分区在 `/dev/nvme0n1p2`，父设备就是 `nvme0n1`。`/proc/diskstats` 里父设备和分区是
    **两组独立的计数**（分区是父设备的子集），拿分区算会漏掉其它分区的流量、还会重复计数。
    解析时精确匹配第 3 列的设备名，`nvme0n1p2` 不会命中 `nvme0n1`。
    第 6 列是读扇区、第 10 列是写扇区，扇区固定 512 字节。

13. **应用进程信息用 `ss -lntp` 一次拿全。**
    它能一行同时给出「监听端口 + pid」，比按端口反查、或按进程名猜都稳。
    拿到 pid 后再读 `/proc/<pid>/status` 的 `VmRSS` 和 `/proc/<pid>/stat` 第 22 字段
    （开机以来的 clock tick，除以 `CLK_TCK`=100 得到启动时间）算已运行时长。

14. **`health.checked` 用「曾经成功过」的粘性标志，不用「这一轮成不成功」。**
    `failedUnits: []` 天然有歧义：既可能是「确实 0 个失败」，也可能是「`systemctl` 跑不起来，查不了」。
    把它画成绿色「全部正常」，一个查不了的面板会冒充成健康的，监控面板就失去可信度了。
    所以采样器上挂一个 `succeeded`，**只从 false 变 true，永远不回退**：
    - `checked: false`（从没成功过）→ 灰色「无法检查」；
    - `checked: true` + `[]` → 绿色「全部正常」；
    - `checked: true` + 有 unit → 红色角标「N 个」+ 可展开。

    为什么不用「这一轮是否成功」：一次瞬时失败（`systemd` 忙、超时）就会把绿牌翻成灰牌，
    那是另一种撒谎。粘性标志 + `stale`（保留上一次的值）才是对的组合。

## 六、排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 顶部一直显示「暂时取不到状态」 | 服务端 `/api/stats` 挂了，`tail -50 /var/log/portal.log` 看日志；页面本身还能用 |
| 卡片显示「离线」但应用明明在跑 | 应用只监听了 `0.0.0.0` 以外的地址？探测走的是 `127.0.0.1`，应用必须在本机 loopback 上能连 |
| 内存/存储/CPU 全是「—」 | 不在 Linux 上跑，或 `/proc` 不可读。这是预期的降级，不是 bug |
| 80 端口起不来 | 见上面「80 端口为什么不用 root」的降级步骤 |
| 网络速率显示 0 B/s | 正常。没流量就是 0，不是没采到；采不到会显示「—」 |
| NPU 卡只显示「未检测到 NPU」 | `/usr/local/sbin/npu-smi` 不存在，或它的输出解析不出来（型号行/显存行缺一）。日志看 `[npu] 采样失败` |
| 服务健康显示灰色「无法检查」 | `systemctl --failed` 跑不动（非 systemd / 容器里没 dbus），**从启动到现在一次都没成功过**。日志看 `[health] 采样失败`。这是「不知道」，不是「没问题」 |
| 服务健康先绿后变灰 | 不该发生。`checked` 是粘性标志，成功过一次就永远是 `true`。如果真出现了，去看 `createSampler` 里 `state.succeeded` 有没有被误重置 |
| TOP 列表只有「—」 | `ps` 跑不动（非 Linux，或 PATH 里没有）。日志看 `[top] 采样失败` |
| 备份卡根本不出现 | `config.json` 没配 `backup`，或 `dir` 不存在 / 是空目录。先 `ls -la <dir>` 确认里面有文件 |
| NPU 卡灰字末尾多出「数据稍旧」 | NPU 采样器最近一次失败了（`npu.stale = true`），显示的是上一次成功采到的值。日志找 `[npu] 采样失败` |

## 七、本机（Windows / macOS）怎么调前端

```bash
cd portal
PORT=8090 node server.js
# 浏览器打开 http://127.0.0.1:8090
```

Windows 上没有 `/proc`、也没有 `npu-smi` / `systemctl` / Linux 版 `ps`，会出现：
CPU「—」（连每核条都不画）、内存「—」、存储读写「—」、网络速率「—」、
NPU 卡只留一句「未检测到 NPU」、服务健康灰色「无法检查」（`checked: false`）、
TOP 只有「—」、备份卡整张不显示，应用两个都「离线」（8888/9999 没在跑）。
**这就是降级路径的正确样子**，说明代码没有假设"一定在 Linux 上"，也不会冒 NaN / undefined 出来。

所以**前端的版式可以在 Windows 上验，数值必须回板子上核对**。
NPU 的解析器是拿真机 `npu-smi info` 的原始输出做 fixture 喂进去验的，
不是照着文档猜的格式。
