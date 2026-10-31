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
  deploy/portal.service  systemd unit
  README.md              本文件
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
journalctl -u portal -n 50 --no-pager
```

正常启动长这样：

```
门户已启动，监听 0.0.0.0:80
  本机访问： http://127.0.0.1
  局域网：  http://192.168.3.185
  网卡：    wlan0  应用：2 个
  采样器：  CPU/网络/磁盘 已预热；NPU 已识别 310B4；服务健康 0 个失败
```

最后一行是预热结果。CPU / 网络 / 磁盘这三项要现采两次（间隔 120ms）才有 delta，
放在启动时做掉，第一个 `/api/stats` 就不用替启动过程付账。
NPU / 失败服务那几项由采样器在启动时立刻跑一轮，所以这里已经能看到结果。

### 更新代码

板子上的 `~/Yangfan_WorkSpace/portal` 是一个 git 检出，以后更新只要：

```bash
cd ~/Yangfan_WorkSpace/portal
git pull --ff-only
sudo systemctl restart portal
```

只改 `config.json` 的应用清单**不需要重启**（每次请求现读）；改了 `server.js` 或 `public/` 下任何文件必须重启。

### 看门狗（为什么必须有）

门户挂在 80 端口，是整台板子的入口。它一旦停下，你既找不到应用入口、也看不到系统状态，
而且不会有任何提示。`Restart=always` 只管「进程崩了」——**手动 stop 或被判 failed 之后，
systemd 不会自己拉起**，必须有人再 `start` 一次。

`deploy/portal-watchdog.{sh,service,timer}` 每 2 分钟检查一次：

- 服务没在跑 → `start`
- 服务在跑但 HTTP 无响应 → 隔 3 秒重试一次，仍不通才 `restart`（避免瞬时抖动误重启）
- 一切正常 → 静默退出，不刷日志

安装：

```bash
sudo install -m 755 deploy/portal-watchdog.sh      /usr/local/bin/portal-watchdog.sh
sudo install -m 644 deploy/portal-watchdog.service /etc/systemd/system/
sudo install -m 644 deploy/portal-watchdog.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now portal-watchdog.timer
```

验证它真的会救：

```bash
sudo systemctl stop portal              # 故意弄挂
sudo systemctl start portal-watchdog    # 手动触发一次，不用等满 2 分钟
systemctl is-active portal              # 应该是 active
journalctl -t portal-watchdog -n 5      # 应能看到「检测到 portal.service 未运行」
```

## 二、加/改应用

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

## 三、接口

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

### 静态文件

`GET /` → `public/index.html`；`/style.css`、`/app.js`、`/favicon.svg` 直接发。
只发 `public/` 下的文件，`..` 和畸形编码一律 404。

## 四、为什么这么做（改代码前先看这几条）

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

## 五、排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 顶部一直显示「暂时取不到状态」 | 服务端 `/api/stats` 挂了，`journalctl -u portal -n 50` 看日志；页面本身还能用 |
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

## 六、本机（Windows / macOS）怎么调前端

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
