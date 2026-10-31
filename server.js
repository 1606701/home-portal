'use strict';

/**
 * 香橙派局域网门户 —— 零依赖 HTTP 服务。
 *
 * 只用 http / fs / path / os / net / child_process 这几个内置模块，一个 npm 包都不引：
 * 板子大概率没有外网，装不了依赖，也不该为这点功能引依赖。
 *
 * 设计取舍（都跟这块板子的实测事实有关，改之前先看 README「为什么这么做」）：
 *   · 内存用 MemTotal - MemAvailable，不用 MemFree —— 后者把缓存算成已用，
 *     这块板子上会显示 90% 已用，纯属吓人。
 *   · CPU 用 /proc/stat 两次采样的 delta，不用 load average ——
 *     这块板子上有 17 个固件内核线程常年挂 D 状态，load 常年 17，
 *     但 top 实测 CPU 94% idle，展示 load 就是撒谎。
 *   · 不做 CPU 温度：/sys/class/thermal 是空的，没有传感器。
 *   · 网卡动态挑「UP 且非 lo 且拿到 IPv4」的那块，不写死 eth0/wlan0。
 *   · 贵的指标（npu-smi 469ms、systemctl 100ms、ps 10ms）全部走后台定时采样，
 *     /api/stats 只读内存快照 —— 这个接口前端每 3 秒轮询一次，必须 < 50ms。
 *
 * 非 Linux 环境（比如在 Windows 上做前端联调）读不到 /proc、也没有 npu-smi，
 * 相关字段一律返回 null，前端显示「—」，不抛错也不给 NaN。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PORT = Number(process.env.PORT) || 80;
const HOST = process.env.HOST || '0.0.0.0';

/** 首次采样时两次读 /proc 的间隔（毫秒）。太短 delta 太小，噪声大。 */
const SAMPLE_MS = 120;
/** CPU / 网络 / 磁盘速率的缓存时间：多个页面同时轮询时不必每次都重新采。 */
const CACHE_MS = 900;
/** 单个应用端口的连通性探测超时。 */
const PROBE_TIMEOUT_MS = 800;
/** 应用探测结果缓存：前端 3 秒轮询一次，不能每次都去敲门。 */
const PROBE_CACHE_MS = 2000;
/** 两次采样的最小间隔（秒）。小于这个数算出来的速率全是噪声。 */
const MIN_RATE_SEC = 0.05;
/**
 * 上一次采样太旧就别拿它做 delta：页面关了几小时再打开时，
 * 用「几小时的平均值」当当前状态会明显偏低，不如重新现采两次。
 */
const STALE_MS = 30000;

/* ---- 后台采样器的周期（毫秒）。超过 5ms 的数据源一律走这里，不进请求路径 ---- */
/** npu-smi info 实测 469ms。 */
const NPU_TTL_MS = 20000;
/** systemctl --failed 约 100ms。 */
const HEALTH_TTL_MS = 30000;
/** ps -eo rss,comm 约 10ms；ss -lntp 同量级，一起按 10s 采。 */
const TOP_TTL_MS = 10000;
const PROCS_TTL_MS = 10000;
/** 备份目录 mtime，只在有变化时才需要重算，给足余量。 */
const BACKUP_TTL_MS = 60000;

/** npu-smi 不在普通用户 PATH 里，必须用绝对路径。 */
const NPU_SMI = '/usr/local/sbin/npu-smi';
/** 根分区在 /dev/nvme0n1p2，父设备固定叫这个（实测）。 */
const DISK_DEV = 'nvme0n1';
/** /proc/diskstats 的扇区单位固定 512 字节。 */
const SECTOR_BYTES = 512;
/** /proc/<pid>/stat 的 starttime 单位是 clock tick，Linux 上 getconf CLK_TCK = 100。 */
const CLK_TCK = 100;

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * 发一个 JSON 响应。
 * @param {http.ServerResponse} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {object} body 要序列化的对象
 * @returns {void}
 */
function sendJSON(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

/**
 * 发一段纯文本（404、500 这种兜底用）。
 * @param {http.ServerResponse} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {string} text 文本内容
 * @returns {void}
 */
function sendText(res, status, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

/**
 * 把一个文件读出来发出去。找不到就 404，不做任何目录列举。
 * @param {http.ServerResponse} res 响应对象
 * @param {string} filePath 已经过白名单校验的绝对路径
 * @returns {void}
 */
function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      sendText(res, 404, '文件不存在');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      // 页面上的 ?v= 才是破缓存的手段，文件本身让浏览器每次都回源校验
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/**
 * 睡一会儿。
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 到点后 resolve
 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 百分比：分母为 0 或非法时返回 null，绝不返回 NaN。
 * @param {number} part 分子
 * @param {number} whole 分母
 * @returns {number|null} 0-100 的百分比，保留一位小数
 */
function pct(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  const v = (part / whole) * 100;
  return Math.round(v * 10) / 10;
}

/* ------------------------------------------------------------------ *
 * CPU：/proc/stat 两次采样的 delta（整体 + 每核）
 * ------------------------------------------------------------------ */

/**
 * @typedef {{idle:number,total:number}} CpuTimes
 * @typedef {{total:CpuTimes,cores:CpuTimes[],ts:number}} CpuSample
 */

/** @type {CpuSample|null} 上一次采样 */
let cpuPrev = null;
/** @type {{usagePct:number|null,perCore:(number|null)[]|null}|null} 上一次算出的结果 */
let cpuSnapshot = null;
/** @type {number} 上一次算出结果的时间戳 */
let cpuSnapTs = 0;
/** @type {Promise<object|null>|null} 正在进行的采样（并发请求共用一次） */
let cpuInFlight = null;

/**
 * 解析 /proc/stat 里的一行 CPU 计数。
 * 只取前 8 个字段（user..steal）：guest/guest_nice 已经含在 user/nice 里，再加会重复计。
 * @param {string} line 形如 "cpu0 300 0 150 2700 30 0 0 0 0 0"
 * @returns {CpuTimes|null} idle 与 total；字段不够或不是数字时 null
 */
function parseCpuLine(line) {
  const cols = String(line).trim().split(/\s+/);
  const nums = cols.slice(1, 9).map(Number);
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
  return {
    idle: nums[3] + (nums[4] || 0),                     // idle + iowait 都算空闲
    total: nums.reduce((sum, n) => sum + (n || 0), 0)
  };
}

/**
 * 读一整个 CPU 快照：第一行是整体，cpu0..cpuN 是每核。
 * @returns {{total:CpuTimes,cores:CpuTimes[]}|null} 读不到 /proc/stat 时 null
 */
function readCpuSnapshot() {
  try {
    const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n');
    let total = null;
    const cores = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.indexOf('cpu') !== 0) break;             // cpu* 全都挤在文件开头
      const name = line.trim().split(/\s+/)[0];
      const parsed = parseCpuLine(line);
      if (!parsed) continue;
      if (name === 'cpu') total = parsed;
      else if (/^cpu\d+$/.test(name)) cores.push(parsed);
    }
    if (!total) return null;
    return { total, cores };
  } catch (err) {
    return null;                                        // 非 Linux / 权限不足
  }
}

/**
 * 两个采样点之间算占用率。
 * @param {CpuTimes} prev 上一次
 * @param {CpuTimes} cur 这一次
 * @param {number|null} fallback 间隔太短（totalDelta<=0）时沿用的旧值
 * @returns {number|null} 0-100，保留一位小数
 */
function diffPct(prev, cur, fallback) {
  const totalDelta = cur.total - prev.total;
  if (!(totalDelta > 0)) return fallback === undefined ? null : fallback;
  const idleDelta = cur.idle - prev.idle;
  const v = 100 * (1 - idleDelta / totalDelta);
  return Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
}

/**
 * 算整体与每核占用率。首次请求（或上次采样过期）时现场隔 SAMPLE_MS 采两次。
 * @returns {Promise<{usagePct:number|null,perCore:(number|null)[]|null}|null>}
 *   读不到 /proc/stat 时 null
 */
function sampleCpu() {
  const now = Date.now();
  if (cpuSnapshot && now - cpuSnapTs < CACHE_MS) return Promise.resolve(cpuSnapshot);

  let start = cpuPrev;
  let warmed = Promise.resolve();
  if (!start || now - start.ts > STALE_MS) {
    const fresh = readCpuSnapshot();
    if (!fresh) return Promise.resolve(null);
    start = { total: fresh.total, cores: fresh.cores, ts: now };
    // 第一次跑（或上一次采样已经过期）没有可用的历史采样，只能现采两次补一个 delta
    warmed = delay(SAMPLE_MS);
  }

  return warmed.then(() => {
    const cur = readCpuSnapshot();
    if (!cur) return null;
    cpuPrev = { total: cur.total, cores: cur.cores, ts: Date.now() };

    const prevPct = cpuSnapshot ? cpuSnapshot.usagePct : null;
    const usagePct = diffPct(start.total, cur.total, prevPct);

    // 每核：拿同下标的上一次采样做 delta；核数对不上就留 null，绝不瞎补
    const prevCores = cpuSnapshot && Array.isArray(cpuSnapshot.perCore) ? cpuSnapshot.perCore : [];
    const perCore = cur.cores.map((c, i) => {
      const base = start.cores[i];
      if (!base) return null;
      return diffPct(base, c, typeof prevCores[i] === 'number' ? prevCores[i] : null);
    });

    cpuSnapshot = { usagePct, perCore: perCore.length ? perCore : null };
    cpuSnapTs = Date.now();
    return cpuSnapshot;
  });
}

/**
 * 带并发合流的 CPU 采样入口：同一时刻多个请求只采一次。
 * @returns {Promise<{usagePct:number|null,perCore:(number|null)[]|null}|null>} 快照
 */
function cpuUsage() {
  if (cpuInFlight) return cpuInFlight;
  cpuInFlight = sampleCpu().then(
    (v) => { cpuInFlight = null; return v; },
    () => { cpuInFlight = null; return null; }
  );
  return cpuInFlight;
}

/* ------------------------------------------------------------------ *
 * 内存 / 磁盘
 * ------------------------------------------------------------------ */

/**
 * 内存用量。used = MemTotal - MemAvailable（不是 MemFree）。
 * @returns {{totalBytes:number,usedBytes:number,availableBytes:number,usedPct:number|null}|null}
 *   读不到 /proc/meminfo 时返回 null
 */
function readMem() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const pick = (key) => {
      const m = text.match(new RegExp('^' + key + ':\\s+(\\d+)\\s+kB', 'm'));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = pick('MemTotal');
    const available = pick('MemAvailable');
    if (total === null || available === null) return null;
    const used = total - available;
    return {
      totalBytes: total,
      usedBytes: used,
      availableBytes: available,
      usedPct: pct(used, total)
    };
  } catch (err) {
    return null;
  }
}

/**
 * 磁盘用量。used 用 blocks - bfree（已分配块），free 用 bavail（非 root 可用的块）。
 * @param {string} target 挂载点或路径
 * @returns {{path:string,totalBytes:number,usedBytes:number,freeBytes:number,usedPct:number|null}|null}
 *   取不到时返回 null
 */
function readDisk(target) {
  try {
    const st = fs.statfsSync(target);
    const bsize = Number(st.bsize);
    const totalBytes = Number(st.blocks) * bsize;
    const usedBytes = (Number(st.blocks) - Number(st.bfree)) * bsize;
    const freeBytes = Number(st.bavail) * bsize;
    return {
      path: target,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPct: pct(usedBytes, totalBytes)
    };
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 磁盘读写速率：/proc/diskstats 的 delta
 * ------------------------------------------------------------------ */

/** @type {{readSectors:number,writeSectors:number,ts:number}|null} 上一次采样 */
let ioPrev = null;
/** @type {{readBytesPerSec:number,writeBytesPerSec:number}|null} 上一次算出的速率 */
let ioRate = null;
/** @type {number} 上一次算出速率的时间戳 */
let ioRateTs = 0;
/** @type {Promise<object>|null} 正在进行的采样 */
let ioInFlight = null;

/**
 * 从 /proc/diskstats 取某个**整盘设备**的累计读写扇区数。
 * 精确匹配第 3 列的设备名，所以 nvme0n1p1 / nvme0n1p2 这些分区行不会被当成父设备。
 * @param {string} dev 设备名，例如 nvme0n1
 * @returns {{readSectors:number,writeSectors:number}|null} 累计扇区；找不到该设备时 null
 */
function readDiskSectors(dev) {
  try {
    const text = fs.readFileSync('/proc/diskstats', 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const cols = lines[i].trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (cols[2] !== dev) continue;                    // 第 3 列是设备名
      const readSectors = Number(cols[5]);              // 第 6 列：读扇区数
      const writeSectors = Number(cols[9]);             // 第 10 列：写扇区数
      if (!Number.isFinite(readSectors) || !Number.isFinite(writeSectors)) return null;
      return { readSectors, writeSectors };
    }
    return null;                                        // 设备不存在
  } catch (err) {
    return null;                                        // 非 Linux
  }
}

/**
 * 算磁盘读写速率（字节/秒）。与 CPU/网络一样：首次现采两次补 delta，之后按间隔算。
 * @param {string} dev 设备名
 * @returns {Promise<{readBytesPerSec:number|null,writeBytesPerSec:number|null}>} 速率
 */
function sampleDiskIo(dev) {
  const empty = { readBytesPerSec: null, writeBytesPerSec: null };
  const now = Date.now();
  if (ioRate && now - ioRateTs < CACHE_MS) return Promise.resolve(ioRate);

  let start = ioPrev;
  let warmed = Promise.resolve();
  if (!start || now - start.ts > STALE_MS) {
    const fresh = readDiskSectors(dev);
    if (!fresh) return Promise.resolve(empty);
    start = { readSectors: fresh.readSectors, writeSectors: fresh.writeSectors, ts: now };
    warmed = delay(SAMPLE_MS);
  }

  return warmed.then(() => {
    const cur = readDiskSectors(dev);
    if (!cur) return empty;
    const curTs = Date.now();
    const secs = (curTs - start.ts) / 1000;
    ioPrev = { readSectors: cur.readSectors, writeSectors: cur.writeSectors, ts: curTs };
    if (!(secs >= MIN_RATE_SEC)) return ioRate || empty;
    ioRate = {
      readBytesPerSec: Math.max(0, Math.round((cur.readSectors - start.readSectors) * SECTOR_BYTES / secs)),
      writeBytesPerSec: Math.max(0, Math.round((cur.writeSectors - start.writeSectors) * SECTOR_BYTES / secs))
    };
    ioRateTs = curTs;
    return ioRate;
  });
}

/**
 * 带并发合流的磁盘速率入口。
 * @param {string} dev 设备名
 * @returns {Promise<{readBytesPerSec:number|null,writeBytesPerSec:number|null}>} 速率
 */
function diskIo(dev) {
  if (ioInFlight) return ioInFlight;
  ioInFlight = sampleDiskIo(dev).then(
    (v) => { ioInFlight = null; return v; },
    () => { ioInFlight = null; return { readBytesPerSec: null, writeBytesPerSec: null }; }
  );
  return ioInFlight;
}

/* ------------------------------------------------------------------ *
 * 网络：动态挑网卡 + /proc/net/dev 的 delta 速率
 * ------------------------------------------------------------------ */

/**
 * 挑一块「有 IPv4、非 loopback、非 internal」的网卡。
 * 香橙派上 eth0 和 bond0 都是 DOWN，只有 wlan0 有地址，所以不能写死名字。
 * @returns {{iface:string|null,ipv4:string|null,state:string}} 网卡信息
 */
function pickIface() {
  let all = {};
  try {
    all = os.networkInterfaces();
  } catch (err) {
    return { iface: null, ipv4: null, state: 'down' };
  }
  const names = Object.keys(all);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (name === 'lo') continue;
    const list = all[name] || [];
    for (let j = 0; j < list.length; j += 1) {
      const addr = list[j];
      // Node 18 起 family 是字符串 'IPv4'，老版本是数字 4，两边都认
      const family = typeof addr.family === 'string' ? addr.family : (addr.family === 4 ? 'IPv4' : '');
      if (family !== 'IPv4') continue;
      if (addr.internal) continue;
      if (!addr.address || addr.address === '127.0.0.1') continue;
      return { iface: name, ipv4: addr.address, state: 'up' };
    }
  }
  return { iface: null, ipv4: null, state: 'down' };
}

/**
 * 从 /proc/net/dev 取某块网卡的累计收发字节。
 * @param {string} iface 网卡名
 * @returns {{rx:number,tx:number}|null} 累计字节，读不到返回 null
 */
function readNetBytes(iface) {
  if (!iface) return null;
  try {
    const text = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const at = line.indexOf(':');
      if (at < 0) continue;                             // 跳过两行表头
      if (line.slice(0, at).trim() !== iface) continue;
      const cols = line.slice(at + 1).trim().split(/\s+/);
      const rx = Number(cols[0]);
      const tx = Number(cols[8]);
      if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
      return { rx, tx };
    }
    return null;                                        // 网卡不在表里
  } catch (err) {
    return null;
  }
}

/** @type {{rx:number,tx:number,ts:number}|null} 上一次网络采样 */
let netPrev = null;
/** @type {{rxBytesPerSec:number,txBytesPerSec:number}|null} 上一次算出的速率 */
let netRate = null;
/** @type {number} 上一次算出速率的时间戳 */
let netRateTs = 0;
/** @type {string|null} 上一次采样用的网卡名 */
let netRateIface = null;
/** @type {Promise<object>|null} 正在进行的采样 */
let netInFlight = null;

/**
 * 算某块网卡的实时速率（字节/秒），首次调用同样现采两次。
 * @param {string} iface 网卡名
 * @returns {Promise<{rxBytesPerSec:number|null,txBytesPerSec:number|null,rxTotalBytes:number|null,txTotalBytes:number|null}>}
 *   速率与累计值；读不到 /proc/net/dev 时全部 null
 */
function sampleNetRate(iface) {
  const empty = { rxBytesPerSec: null, txBytesPerSec: null, rxTotalBytes: null, txTotalBytes: null };
  if (!iface) return Promise.resolve(empty);

  const now = Date.now();
  if (netRate && netRateIface === iface && now - netRateTs < CACHE_MS) {
    return Promise.resolve({
      rxBytesPerSec: netRate.rxBytesPerSec,
      txBytesPerSec: netRate.txBytesPerSec,
      rxTotalBytes: netPrev ? netPrev.rx : null,
      txTotalBytes: netPrev ? netPrev.tx : null
    });
  }

  let start = (netPrev && netRateIface === iface && now - netPrev.ts <= STALE_MS) ? netPrev : null;
  let warmed = Promise.resolve();
  if (!start) {
    start = readNetBytes(iface);
    if (!start) return Promise.resolve(empty);
    start = { rx: start.rx, tx: start.tx, ts: Date.now() };
    warmed = delay(SAMPLE_MS);
  }

  return warmed.then(() => {
    const cur = readNetBytes(iface);
    if (!cur) return empty;
    const curTs = Date.now();
    const secs = (curTs - start.ts) / 1000;
    netPrev = { rx: cur.rx, tx: cur.tx, ts: curTs };
    netRateIface = iface;
    if (!(secs >= MIN_RATE_SEC)) {
      // 两次采样挨得太近，delta 会被噪声放大，沿用上次算出来的速率
      return {
        rxBytesPerSec: netRate ? netRate.rxBytesPerSec : null,
        txBytesPerSec: netRate ? netRate.txBytesPerSec : null,
        rxTotalBytes: cur.rx,
        txTotalBytes: cur.tx
      };
    }
    const rxRate = Math.max(0, (cur.rx - start.rx) / secs);
    const txRate = Math.max(0, (cur.tx - start.tx) / secs);
    netRate = {
      rxBytesPerSec: Math.round(rxRate),
      txBytesPerSec: Math.round(txRate)
    };
    netRateTs = curTs;
    return {
      rxBytesPerSec: netRate.rxBytesPerSec,
      txBytesPerSec: netRate.txBytesPerSec,
      rxTotalBytes: cur.rx,
      txTotalBytes: cur.tx
    };
  });
}

/**
 * 带并发合流的网络速率入口。
 * @param {string} iface 网卡名
 * @returns {Promise<object>} 速率与累计字节
 */
function netRateOf(iface) {
  if (netInFlight) return netInFlight;
  netInFlight = sampleNetRate(iface).then(
    (v) => { netInFlight = null; return v; },
    () => {
      netInFlight = null;
      return { rxBytesPerSec: null, txBytesPerSec: null, rxTotalBytes: null, txTotalBytes: null };
    }
  );
  return netInFlight;
}

/* ------------------------------------------------------------------ *
 * 主机信息
 * ------------------------------------------------------------------ */

/**
 * 发行版名字。优先 /etc/os-release 的 PRETTY_NAME，取不到就退回 os.type()。
 * @returns {string} 例如 "Ubuntu 22.04.3 LTS"
 */
function readDistro() {
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const m = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  } catch (err) {
    /* 没有这个文件就走下面的兜底 */
  }
  return os.type();
}

/* ------------------------------------------------------------------ *
 * 外部命令
 * ------------------------------------------------------------------ */

/**
 * 跑一个外部命令并把 stdout 拿回来。
 * 命令不存在 / 超时 / 退出码非 0 都不抛错：只要 stdout 有内容就算拿到了，
 * 因为 npu-smi 这类工具常见「打印完表格再返回非 0」。
 * @param {string} cmd 可执行文件（要绝对路径，或确定在 PATH 里）
 * @param {string[]} args 参数
 * @param {number} timeoutMs 超时
 * @returns {Promise<{ok:boolean,out:string,error:string|null}>} 结果
 */
function execText(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8'
    }, (err, stdout) => {
      const out = String(stdout || '');
      if (err && !out) {
        resolve({ ok: false, out: '', error: err.message || String(err) });
        return;
      }
      resolve({ ok: true, out, error: err ? (err.message || String(err)) : null });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 后台采样器：贵的指标一律在这里采，/api/stats 只读快照
 * ------------------------------------------------------------------ */

/**
 * 建一个后台采样器。
 *   · 立刻跑一次（首屏不能空着），之后每 ttlMs 跑一次
 *   · 定时器 unref()，不因为采样器而拖住进程退出
 *   · 单次采样抛错只标记 stale、保留上一次的值，绝不影响别的源、也不让进程崩
 *   · 同一个源上一次还没跑完就跳过这一轮，不会堆积
 * @param {string} name 采样器名字（打日志用）
 * @param {number} ttlMs 周期
 * @param {function():Promise<*>} fn 采样函数
 * @returns {{value:*,at:number,stale:boolean,error:string|null,succeeded:boolean,run:function():void}}
 *   快照对象，value 就是最近一次成功的结果；succeeded 是「曾经成功过」的粘性标志
 */
function createSampler(name, ttlMs, fn) {
  const state = {
    value: null,
    at: 0,
    stale: false,
    error: null,
    running: false,
    lastLogged: null,
    // 「这个源曾经成功执行过一次」的粘性标志：只从 false 变 true，永远不回退。
    // 用来区分「确实是 0 个失败」和「systemctl 根本跑不起来，查不了」。
    // 刻意不用「这一轮是否成功」——一次瞬时失败就会把绿牌翻成灰牌，那是另一种撒谎。
    succeeded: false,
    run: null
  };

  state.run = () => {
    if (state.running) return;
    state.running = true;
    let p;
    try {
      p = Promise.resolve(fn());
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then((v) => {
      state.value = v;
      state.at = Date.now();
      state.stale = false;
      state.error = null;
      state.succeeded = true;
      state.running = false;
    }, (err) => {
      state.stale = true;
      state.error = err && err.message ? err.message : String(err);
      state.running = false;
      // 只在错误信息变化时打日志，避免一个坏源每 20 秒刷一次 journal
      if (state.lastLogged !== state.error) {
        state.lastLogged = state.error;
        console.error('[' + name + '] 采样失败：' + state.error);
      }
    });
  };

  state.run();
  const timer = setInterval(state.run, ttlMs);
  if (typeof timer.unref === 'function') timer.unref();
  return state;
}

/**
 * 等若干采样器跑完首轮（拿到结果或报错都算完成），超时也返回，绝不阻塞启动。
 * 用途只有一个：启动横幅要打「NPU 有没有」「健康检查能不能查」，
 * 而这两个采样器要几百毫秒，不等就会把「还没采」写成「未检测到」——那是两回事。
 */
function waitFirstRound(list, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const done = list.every((s) => s.at > 0 || s.error);
      if (done || Date.now() > deadline) return resolve(done);
      setTimeout(tick, 50);
    };
    tick();
  });
}

// 这三种状态必须分开说：真的识别到 / 真的没有 / 还没采完
function describeNpu(s) {
  if (s.error) return '采样失败（' + s.error + '）';
  if (s.at > 0) return s.value ? '已识别 ' + s.value.chip : '未检测到';
  return '首轮采样未完成';
}

function describeHealth(s) {
  if (s.error) return '无法检查（' + s.error + '）';
  if (s.succeeded) return (Array.isArray(s.value) ? s.value.length : '?') + ' 个失败';
  return '首轮采样未完成';
}

/**
 * 解析 `npu-smi info` 的表格输出。
 *
 * 真实输出长这样（列宽会随版本变，所以不能按固定列号切）：
 *   | 0       310B4                 | Alarm           | 0.0          45                15    / 15       |
 *   | 0       0                     | NA              | 0            2682 / 7545                            |
 *
 * 第一行：槽位 + 型号 / 健康 / 功耗 + 温度 + Hugepages
 * 第二行：槽位 + Bus-Id / NA / AICore% + 显存 MB
 *
 * @param {string} text npu-smi 的 stdout
 * @returns {object|null} 解析出的对象；认不出型号就 null（宁可整块不显示，也不显示错的）
 */
function parseNpuInfo(text) {
  if (!text || !String(text).trim()) return null;
  const lines = String(text).split('\n');

  let chip = null;
  let health = null;
  let powerW = null;
  let tempC = null;
  let aicorePct = null;
  let memUsedMB = null;
  let memTotalMB = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indexOf('|') === -1) continue;
    const raw = line.split('|');
    // 只丢掉首尾 `|` 造成的空串，中间的保留（否则列会错位）
    const cells = raw.slice(1, raw.length - 1).map((c) => c.trim());
    if (cells.length < 3) continue;

    const head = cells[0].split(/\s+/).filter(Boolean);

    // 型号行：第一格是「槽位 型号」，型号形如 310B4（字母+数字）
    if (chip === null && head.length >= 2 && /^[A-Za-z]*\d+[A-Za-z0-9]*$/.test(head[1])) {
      chip = head[1];
      health = cells[1] && cells[1] !== 'NA' ? cells[1] : null;
      // 功耗与温度：该格里前两个数字就是 Power(W) 和 Temp(C)，后面可能跟着 "15 / 15"（Hugepages）
      const nums = cells[2].split(/\s+/).filter((t) => /^-?\d+(\.\d+)?$/.test(t)).map(Number);
      if (nums.length >= 2) {
        powerW = nums[0];
        tempC = nums[1];
      }
      continue;
    }

    // 显存行：AICore% 后面跟着 "已用 / 总量"（MB）
    if (memUsedMB === null) {
      const m = cells[2].match(/^(-?\d+(?:\.\d+)?)\s+(\d+)\s*\/\s*(\d+)$/);
      if (m) {
        aicorePct = Number(m[1]);
        memUsedMB = Number(m[2]);
        memTotalMB = Number(m[3]);
      }
    }
  }

  // 型号和显存两行缺一不可：只有半张表的 NPU 卡会显示成「型号 X、显存 —」，
  // 看起来像板子出问题了，不如整块不显示。解析不完整就当没检测到。
  if (!chip || memUsedMB === null || memTotalMB === null) return null;
  return {
    available: true,
    chip,
    health,
    powerW,
    tempC,
    aicorePct,
    memUsedMB,
    memTotalMB,
    faultyChips: null,
    stale: false
  };
}

/**
 * 采一次 NPU：先跑 info 拿表格，再（可选）跑 board 拿故障芯片数。
 * 两个命令都在后台采样器里跑，469ms 不会落到请求路径上。
 * @returns {Promise<object|null>} NPU 快照
 */
async function sampleNpu() {
  if (!fs.existsSync(NPU_SMI)) return null;            // 板子没有 npu-smi 就是没有 NPU
  const info = await execText(NPU_SMI, ['info'], 4000);
  const parsed = parseNpuInfo(info.out);
  if (!parsed) return null;

  // Faulty Chip Count 只有 board 子命令给；拿不到就留 null，不影响其它字段
  const board = await execText(NPU_SMI, ['info', '-t', 'board', '-i', '0'], 4000);
  const m = board.out.match(/Faulty\s+Chip\s+Count\s*[:\|]\s*(\d+)/i);
  if (m) parsed.faultyChips = Number(m[1]);
  return parsed;
}

/**
 * 解析 `systemctl --failed --no-legend --no-pager` 的输出。
 * @param {string} text stdout
 * @returns {string[]} 失败的 unit 名（可能为空数组）
 */
function parseFailedUnits(text) {
  const units = [];
  String(text || '').split('\n').forEach((line) => {
    const cleaned = line.replace(/^[\s●*]+/, '').trim();
    if (!cleaned) return;
    const tokens = cleaned.split(/\s+/);
    const unit = tokens.filter((t) => /\.(service|path|socket|mount|timer|target|device|scope)$/.test(t))[0];
    if (unit) units.push(unit);
  });
  return units;
}

/**
 * 采一次失败服务列表。
 * @returns {Promise<string[]>} unit 名数组
 */
async function sampleFailedUnits() {
  const res = await execText('systemctl', ['--failed', '--no-legend', '--no-pager'], 4000);
  if (!res.ok) throw new Error(res.error || 'systemctl 执行失败');
  return parseFailedUnits(res.out);
}

/**
 * 解析 `ps -eo rss,comm --sort=-rss` 的输出，取前 n 条。
 * @param {string} text stdout
 * @param {number} n 取几条
 * @returns {{comm:string,rssBytes:number}[]} 进程列表
 */
function parseTopProcs(text, n) {
  const out = [];
  String(text || '').split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const m = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!m) return;                                     // 表头 RSS COMMAND 走这里
    const kb = Number(m[1]);
    if (!Number.isFinite(kb) || kb <= 0) return;
    out.push({ comm: m[2].trim(), rssBytes: kb * 1024 });  // ps 的 rss 单位是 KB
  });
  return out.slice(0, n);
}

/**
 * 采一次进程 TOP 3。
 * @returns {Promise<{comm:string,rssBytes:number}[]>} 列表
 */
async function sampleTopProcs() {
  const res = await execText('ps', ['-eo', 'rss,comm', '--sort=-rss'], 4000);
  if (!res.ok) throw new Error(res.error || 'ps 执行失败');
  return parseTopProcs(res.out, 3);
}

/**
 * 解析 `ss -lntp` 的输出，得到「监听端口 → pid」映射。
 * 一行同时给出端口和进程，比按进程名猜便宜得多。
 * @param {string} text stdout
 * @returns {Object<number,number>} 端口 → pid
 */
function parseListenPids(text) {
  const map = {};
  String(text || '').split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('LISTEN') !== 0) return;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 6) return;
    const port = Number(String(cols[3]).split(':').pop());   // 本地地址那一列
    if (!Number.isFinite(port)) return;
    const m = trimmed.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (!m) return;
    if (map[port] === undefined) map[port] = Number(m[2]);
  });
  return map;
}

/**
 * 读一个进程的常驻内存与已运行时长。
 * @param {number} pid 进程号
 * @returns {{rssBytes:number|null,uptimeSec:number|null}} 取不到就是 null
 */
function readProcInfo(pid) {
  const out = { rssBytes: null, uptimeSec: null };
  try {
    const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
    const kb = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (kb) out.rssBytes = Number(kb[1]) * 1024;
  } catch (err) { /* 进程刚好退出 */ }
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = stat.lastIndexOf(')');                // comm 里可能有空格和括号
    const rest = stat.slice(close + 2).split(' ');
    const startTicks = Number(rest[19]);                // 第 22 个字段（comm 之后第 20 个）
    if (Number.isFinite(startTicks)) {
      out.uptimeSec = Math.max(0, Math.round(os.uptime() - startTicks / CLK_TCK));
    }
  } catch (err) { /* 同上 */ }
  return out;
}

/**
 * 采一次「每个监听端口对应的进程」信息。
 * @returns {Promise<Object<number,{pid:number,rssBytes:number|null,uptimeSec:number|null}>>} 端口 → 进程信息
 */
async function sampleAppProcs() {
  const res = await execText('ss', ['-lntp'], 4000);
  if (!res.ok) return {};
  const ports = parseListenPids(res.out);
  const out = {};
  Object.keys(ports).forEach((port) => {
    const pid = ports[port];
    const info = readProcInfo(pid);
    out[port] = { pid, rssBytes: info.rssBytes, uptimeSec: info.uptimeSec };
  });
  return out;
}

/**
 * 把时间格式化成带时区偏移的本地 ISO 串，例如 2026-10-30T03:00:14+08:00。
 * 不用 toISOString()：那是 UTC，页面上直接显示会和用户看到的钟差 8 小时。
 * @param {Date} d 时间
 * @returns {string} 本地时间 + 偏移
 */
function toLocalIso(d) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}

/**
 * 采一次备份目录的最新文件时间。
 * @param {object|null} cfg config.json 里的 backup 段
 * @returns {Promise<object|null>} {label,lastAt,ageHours}；没配或目录空则 null
 */
async function sampleBackup(cfg) {
  if (!cfg || !cfg.dir) return null;
  let names;
  try {
    names = await fs.promises.readdir(cfg.dir);
  } catch (err) {
    return null;                                        // 目录不存在
  }
  if (!names.length) return null;

  let newest = null;
  for (let i = 0; i < names.length; i += 1) {
    const full = path.join(cfg.dir, names[i]);
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile()) continue;
      if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = { mtimeMs: st.mtimeMs, name: names[i] };
      }
    } catch (err) { /* 读不到的条目跳过 */ }
  }
  if (!newest) return null;

  const ageMs = Date.now() - newest.mtimeMs;
  return {
    label: cfg.label || '备份',
    lastAt: toLocalIso(new Date(newest.mtimeMs)),
    ageHours: Math.round((ageMs / 3600000) * 10) / 10
  };
}

/* ------------------------------------------------------------------ *
 * 应用清单 + 端口探测
 * ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  title: '局域网控制台',
  apps: [
    { id: 'homebox', name: '家庭收纳', desc: '找东西、记一件、衣柜', port: 8888, accent: '#B4633A' },
    { id: 'photo-frame', name: '相框', desc: '照片自动播放', port: 9999, accent: '#6B7F5E' }
  ],
  backup: null
};

/** @type {object|null} 上一次读成功的 config.json（文件被改坏时继续用这份） */
let lastGoodConfig = null;

/**
 * 读应用清单。允许改完 config.json 不重启就生效，读失败时用上一份 / 内置默认。
 * @returns {{title:string,apps:object[],backup:object|null}} 清单（backup 段可选）
 */
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const apps = Array.isArray(parsed.apps) ? parsed.apps : [];
    const clean = apps.filter((a) => a && a.id && Number.isFinite(Number(a.port)))
      .map((a) => ({
        id: String(a.id),
        name: String(a.name || a.id),
        desc: String(a.desc || ''),
        port: Number(a.port),
        accent: String(a.accent || '#B4633A'),
        // 版本对比/升级用。没配 dir 就表示这个应用不纳管版本，
        // 页面上会显示「未纳入版本管理」，而不是假装能升级。
        dir: a.dir ? String(a.dir) : null,
        unit: a.unit ? String(a.unit) : null,
        branch: String(a.branch || 'main'),
        mirror: String(a.mirror || 'mirror'),
        mirrorPath: a.mirrorPath ? String(a.mirrorPath) : null
      }));
    // backup 是可选段：没配就 null，前端据此不显示这张卡
    const rawBackup = parsed.backup;
    const backup = (rawBackup && typeof rawBackup === 'object' && rawBackup.dir)
      ? { label: String(rawBackup.label || '备份'), dir: String(rawBackup.dir) }
      : null;
    // self 是门户自己：它不在 apps 里，但升级时也要能看到自己的版本
    const rawSelf = parsed.self;
    const self = (rawSelf && typeof rawSelf === 'object' && rawSelf.dir)
      ? {
        id: String(rawSelf.id || 'portal'),
        name: String(rawSelf.name || '门户'),
        dir: String(rawSelf.dir),
        unit: String(rawSelf.unit || 'portal.service'),
        branch: String(rawSelf.branch || 'main'),
        mirror: String(rawSelf.mirror || 'mirror'),
        mirrorPath: rawSelf.mirrorPath ? String(rawSelf.mirrorPath) : null
      }
      : null;
    const cfg = { title: String(parsed.title || DEFAULT_CONFIG.title), apps: clean, backup, self };
    lastGoodConfig = cfg;
    return cfg;
  } catch (err) {
    if (lastGoodConfig) return lastGoodConfig;
    return DEFAULT_CONFIG;
  }
}

/**
 * 探一个本地端口：800ms 内能连上就算在线，并记下握手耗时。
 * 只连 127.0.0.1，不产生任何应用层请求，对目标服务无副作用。
 * @param {number} port 端口
 * @returns {Promise<{up:boolean,latencyMs:number|null}>} 探测结果
 */
function probePort(port) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    let settled = false;
    const sock = net.connect({ host: '127.0.0.1', port });

    const finish = (up) => {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      sock.destroy();
      resolve({ up, latencyMs: up ? Math.max(1, Math.round(ms)) : null });
    };

    sock.setTimeout(PROBE_TIMEOUT_MS, () => { finish(false); });
    sock.once('connect', () => { finish(true); });
    sock.once('error', () => { finish(false); });
  });
}

/** @type {{ts:number,byPort:object}|null} 上一次探测结果缓存 */
let probeCache = null;
/** @type {Promise<object>|null} 正在进行的探测 */
let probeInFlight = null;

/**
 * 并发探测所有应用（串行的话两个离线应用就要等 1.6 秒）。
 * @param {object[]} apps 应用清单
 * @returns {Promise<object>} 端口 → {up, latencyMs}
 */
function probeAll(apps) {
  const now = Date.now();
  if (probeCache && now - probeCache.ts < PROBE_CACHE_MS) return Promise.resolve(probeCache.byPort);
  if (probeInFlight) return probeInFlight;

  const jobs = apps.map((app) => probePort(app.port).then((r) => [app.port, r]));
  probeInFlight = Promise.all(jobs).then((pairs) => {
    const byPort = {};
    pairs.forEach((pair) => { byPort[pair[0]] = pair[1]; });
    probeCache = { ts: Date.now(), byPort };
    probeInFlight = null;
    return byPort;
  }, () => {
    probeInFlight = null;
    return {};
  });
  return probeInFlight;
}

/* ------------------------------------------------------------------ *
 * 聚合 /api/stats
 * ------------------------------------------------------------------ */

/**
 * 采样器实例。放在这里（而不是文件靠前处）是因为 backup 采样器要用 readConfig()：
 * 启动时采样器会立刻跑一轮，那时 DEFAULT_CONFIG / lastGoodConfig 必须已经初始化。
 */
const samplers = {
  npu: createSampler('npu', NPU_TTL_MS, sampleNpu),
  health: createSampler('health', HEALTH_TTL_MS, sampleFailedUnits),
  top: createSampler('top', TOP_TTL_MS, sampleTopProcs),
  procs: createSampler('procs', PROCS_TTL_MS, sampleAppProcs),
  // backup 依赖 config.json 里的 backup.dir，每次现读最新配置（改完不用重启）
  backup: createSampler('backup', BACKUP_TTL_MS, () => sampleBackup(readConfig().backup))
};

/**
 * 汇总一次完整状态。
 * @returns {Promise<object>} 见 README 的接口说明
 */
function collectStats() {
  const cfg = readConfig();
  const ifaceInfo = pickIface();

  // 请求路径上只做三件便宜事：/proc/stat、/proc/net/dev、/proc/diskstats（都 <2ms）
  // 加一次 TCP 探测（并发、最多 800ms）。贵的东西全在 samplers 里，这里只读快照。
  return Promise.all([cpuUsage(), netRateOf(ifaceInfo.iface), diskIo(DISK_DEV), probeAll(cfg.apps)])
    .then((results) => {
      const cpu = results[0];
      const netRateInfo = results[1];
      const ioRateInfo = results[2];
      const byPort = results[3] || {};
      const procByPort = samplers.procs.value || {};

      // cores 与 perCore 必须一一对应，前端靠下标画「核0 核1 …」。
      // /proc/stat 的行数和 os.cpus() 在个别容器里可能对不上：多的截掉、少的补 null，
      // 保证 perCore.length === cores，绝不出现条数对不齐的半张卡。
      const cores = Array.isArray(os.cpus()) ? os.cpus().length : null;
      let perCore = cpu ? cpu.perCore : null;
      if (perCore && cores) {
        if (perCore.length > cores) {
          perCore = perCore.slice(0, cores);
        } else if (perCore.length < cores) {
          perCore = perCore.slice();
          while (perCore.length < cores) perCore.push(null);
        }
      }

      return {
        ok: true,
        host: {
          hostname: os.hostname(),
          distro: readDistro(),
          kernel: os.release(),
          uptimeSec: Math.round(os.uptime())
        },
        cpu: {
          cores,
          usagePct: cpu ? cpu.usagePct : null,
          perCore
        },
        mem: readMem(),
        disk: Object.assign({}, readDisk('/'), {
          readBytesPerSec: ioRateInfo.readBytesPerSec,
          writeBytesPerSec: ioRateInfo.writeBytesPerSec
        }),
        net: {
          iface: ifaceInfo.iface,
          ipv4: ifaceInfo.ipv4,
          state: ifaceInfo.state,
          rxBytesPerSec: netRateInfo.rxBytesPerSec,
          txBytesPerSec: netRateInfo.txBytesPerSec,
          rxTotalBytes: netRateInfo.rxTotalBytes,
          txTotalBytes: netRateInfo.txTotalBytes
        },
        npu: samplers.npu.value
          ? Object.assign({}, samplers.npu.value, { stale: !!samplers.npu.stale })
          : null,
        // checked=false 表示这个采样器从没成功执行过一次（systemctl 不存在 / spawn 失败 /
        // 退出码非 0 且 stdout 为空）。此时 failedUnits 必然为空数组，但那是「不知道」，
        // 不是「0 个失败」——前端必须画灰色「无法检查」，绝不能画绿。
        health: {
          checked: samplers.health.succeeded === true,
          failedUnits: Array.isArray(samplers.health.value) ? samplers.health.value : []
        },
        top: Array.isArray(samplers.top.value) ? samplers.top.value : [],
        backup: samplers.backup.value || null,
        apps: cfg.apps.map((app) => {
          const hit = byPort[app.port] || { up: false, latencyMs: null };
          const proc = procByPort[app.port] || {};
          return {
            id: app.id,
            name: app.name,
            port: app.port,
            up: !!hit.up,
            latencyMs: hit.latencyMs === null || hit.latencyMs === undefined ? null : hit.latencyMs,
            rssBytes: typeof proc.rssBytes === 'number' ? proc.rssBytes : null,
            uptimeSec: typeof proc.uptimeSec === 'number' ? proc.uptimeSec : null
          };
        })
      };
    });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/**
 * 把 URL 路径解析成 public/ 下的真实文件路径，任何越界一律返回 null。
 * @param {string} urlPath 形如 /style.css 的路径（未解码）
 * @returns {string|null} 绝对路径，或 null 表示不放行
 */
function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (err) {
    return null;                                        // 畸形百分号编码
  }
  if (decoded.indexOf('\0') !== -1) return null;
  const trimmed = decoded.replace(/^[/\\]+/, '');
  const segments = trimmed.split(/[/\\]/);
  if (segments.indexOf('..') !== -1) return null;        // 直接挡住 ../
  const full = path.resolve(PUBLIC_DIR, trimmed);
  const rel = path.relative(PUBLIC_DIR, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/**
 * 请求总入口。
 * @param {http.IncomingMessage} req 请求
 * @param {http.ServerResponse} res 响应
 * @returns {void}
 */
function handle(req, res) {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (err) {
    sendText(res, 400, '请求地址不合法');
    return;
  }

  // 升级是唯一会改动磁盘的接口，只允许 POST，且必须带口令
  if (pathname === '/api/upgrade') {
    if (req.method !== 'POST') {
      sendJSON(res, 405, { ok: false, error: '升级只接受 POST' });
      return;
    }
    readJsonBody(req).then((body) => {
      if (!body) {
        sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      return doUpgrade(body).then((r) => {
        sendJSON(res, r.status, r.body);
      });
    }).catch((err) => {
      console.error('[upgrade] 升级时出错：' + (err && err.message ? err.message : err));
      sendJSON(res, 500, { ok: false, error: '升级过程中出错' });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, '只支持 GET');
    return;
  }

  if (pathname === '/api/versions') {
    // 走 10 秒缓存：一次采集要跑 3 个应用 × 6 条 git 命令，不该每次轮询都重跑。
    // 升级成功后 doUpgrade 会主动把缓存打掉，所以点完升级立刻能看到新版本。
    collectVersions(false).then((list) => {
      sendJSON(res, 200, { ok: true, hasToken: !!readUpgradeToken(), list: list });
    }).catch((err) => {
      console.error('[versions] 采集失败：' + (err && err.message ? err.message : err));
      sendJSON(res, 200, { ok: false, error: '版本信息采集失败', list: [] });
    });
    return;
  }

  if (pathname === '/api/stats') {
    collectStats().then((stats) => {
      sendJSON(res, 200, stats);
    }).catch((err) => {
      console.error('[stats] 采集失败：' + err.message);
      sendJSON(res, 200, { ok: false, error: '状态采集失败' });
    });
    return;
  }

  if (pathname === '/api/apps') {
    const cfg = readConfig();
    // 只吐前端要用的字段：dir/unit 是服务端内部信息，没必要发给浏览器
    const apps = cfg.apps.map((a) => ({
      id: a.id, name: a.name, desc: a.desc, port: a.port, accent: a.accent
    }));
    sendJSON(res, 200, { ok: true, title: cfg.title, apps: apps });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  if (pathname.indexOf('/api/') === 0) {
    sendJSON(res, 404, { ok: false, error: '接口不存在' });
    return;
  }

  const file = resolveStatic(pathname);
  if (!file) {
    sendText(res, 404, '页面不存在');
    return;
  }
  sendFile(res, file);
}

/* ------------------------------------------------------------------ *
 * 版本对比与一键升级
 *
 * 为什么不在页面上直接 `git pull`：这块板子连不上 github.com:443（实测 curl 8 秒超时，
 * git pull 卡 130 秒后 Connection timed out）。所以升级来源是板子上的 bare 镜像
 * ~/Yangfan_WorkSpace/git-mirror/*.git，你在开发机上 `git push mirror main` 就等于发布。
 * 「检查更新」= 工作区 HEAD 与镜像分支比较，全程本地文件操作，不依赖外网。
 *
 * 三条安全底线：
 *   1. 只做 `merge --ff-only`，绝不做 rebase / reset —— 升级不该改写历史，也不该丢提交。
 *   2. 工作区有未提交改动就拒绝，本地有未推送提交也拒绝 —— 不覆盖你手改的东西。
 *   3. HomeBox 的 data/ 在 .gitignore 里，ff 合并碰不到它，物品数据和照片不会被升级影响。
 * ------------------------------------------------------------------ */

/** 口令文件：刻意放在仓库外（因为仓库会推到公开 GitHub），并由 .gitignore 兜底。 */
const TOKEN_FILE = path.join(ROOT, '.upgrade-token');
/** 版本信息缓存：3 个应用 × 6 条 git 命令，没必要每次轮询都重跑。 */
const VERSIONS_TTL_MS = 10 * 1000;

let versionsCache = { at: 0, value: null };

/**
 * 跑一个外部命令，统一返回结构，不抛异常。
 * @param {string} cmd 命令
 * @param {string[]} args 参数
 * @param {number} [timeoutMs] 超时毫秒
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, error:(string|null)}>} 结果
 */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let error = null;
        if (err) error = err.killed ? '命令超时' : (err.message || String(err));
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error
        });
      });
  });
}

/** 取错误输出里最后一行有用的内容，别把整段 git 输出怼到页面上。 */
function lastLine(text) {
  const lines = String(text || '').trim().split('\n').filter((l) => l.trim());
  if (!lines.length) return '';
  return lines[lines.length - 1].trim().slice(0, 200);
}

/**
 * 采集某个应用的版本信息（会先 fetch 一次镜像，只更新 refs，不动工作区文件）。
 * @param {object} app 配置项，需要有 id/name/dir/unit/branch/mirror
 * @returns {Promise<object>} 版本信息
 */
async function probeVersion(app) {
  const out = {
    id: app.id,
    name: app.name,
    managed: false,
    current: null,
    mirror: null,
    behind: 0,
    ahead: 0,
    dirty: false,
    pending: [],
    fetched: false,
    error: null
  };

  if (!app.dir) {
    out.error = '没有配置目录';
    return out;
  }
  if (!fs.existsSync(path.join(app.dir, '.git'))) {
    out.error = '这个目录不是 git 仓库';
    return out;
  }

  const branch = app.branch || 'main';
  const remote = app.mirror || 'mirror';
  const remoteRef = remote + '/' + branch;
  out.managed = true;
  out.branch = branch;
  out.remoteRef = remoteRef;

  // 只更新远端跟踪分支，工作区一个字节都不碰。
  // 优先用配置里的绝对路径（mirrorPath）当抓取源，而不是仓库里配的 remote：
  // 门户自己的仓库会被从开发机整份同步过去（含 .git/config），
  // 那时 remote 可能指向开发机的 SSH 地址，在板子上根本用不了。
  const source = app.mirrorPath || remote;
  const fetchRes = await run('git', ['-C', app.dir, 'fetch', '--quiet', source,
    '+' + 'refs/heads/' + branch + ':refs/remotes/' + remote + '/' + branch], 10000);
  out.fetched = fetchRes.ok;
  if (!fetchRes.ok) out.error = '拉取镜像失败：' + (lastLine(fetchRes.stderr) || fetchRes.error || '未知原因');

  const cur = await run('git', ['-C', app.dir, 'log', '-1', '--format=%h%x00%s%x00%cI']);
  if (cur.ok) {
    const parts = cur.stdout.trim().split('\x00');
    out.current = { short: parts[0] || '?', subject: parts[1] || '', date: parts[2] || '' };
  }

  // 脏工作区必须知道：「有未提交改动」时页面要明确告诉人为什么不能升级
  const dirtyRes = await run('git', ['-C', app.dir, 'status', '--porcelain']);
  out.dirty = dirtyRes.ok && dirtyRes.stdout.trim() !== '';

  const hasRemote = await run('git', ['-C', app.dir, 'rev-parse', '--verify', '--quiet', remoteRef]);
  if (hasRemote.ok) {
    const mirrorLog = await run('git', ['-C', app.dir, 'log', '-1', '--format=%h%x00%s%x00%cI', remoteRef]);
    if (mirrorLog.ok) {
      const parts = mirrorLog.stdout.trim().split('\x00');
      out.mirror = { short: parts[0] || '?', subject: parts[1] || '', date: parts[2] || '' };
    }
    const behind = await run('git', ['-C', app.dir, 'rev-list', '--count', 'HEAD..' + remoteRef]);
    if (behind.ok) out.behind = Number(behind.stdout.trim()) || 0;
    const ahead = await run('git', ['-C', app.dir, 'rev-list', '--count', remoteRef + '..HEAD']);
    if (ahead.ok) out.ahead = Number(ahead.stdout.trim()) || 0;
    if (out.behind > 0) {
      const pend = await run('git', ['-C', app.dir, 'log', '--oneline', '-5', 'HEAD..' + remoteRef]);
      if (pend.ok) out.pending = pend.stdout.trim().split('\n').filter((l) => l.trim());
    }
  } else if (out.fetched) {
    out.error = '镜像里还没有分支 ' + branch;
  }

  return out;
}

/** 门户自己也要显示在版本列表里，它不在 config.apps 中。 */
function versionTargets() {
  const cfg = readConfig();
  const list = [];
  if (cfg.self && cfg.self.dir) list.push(Object.assign({ name: '香橙派门户' }, cfg.self));
  (cfg.apps || []).forEach((app) => {
    if (app.dir) list.push(app);
  });
  return list;
}

/**
 * 采集全部应用的版本信息（带 10 秒缓存）。
 * @param {boolean} [force] 忽略缓存
 * @returns {Promise<object[]>} 版本信息列表
 */
async function collectVersions(force) {
  const now = Date.now();
  if (!force && versionsCache.value && now - versionsCache.at < VERSIONS_TTL_MS) {
    return versionsCache.value;
  }
  const list = await Promise.all(versionTargets().map((app) => probeVersion(app)));
  versionsCache = { at: now, value: list };
  return list;
}

/**
 * 读升级口令。文件不存在就返回 null —— 此时升级功能整体不可用，
 * 而不是「没有口令就放行」。
 * @returns {string|null} 口令
 */
function readUpgradeToken() {
  try {
    const s = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return s || null;
  } catch (err) {
    return null;
  }
}

/**
 * 恒定时间比较口令，避免用响应时间猜口令。
 * @param {string} given 用户提交的口令
 * @returns {boolean} 是否正确
 */
function tokenMatches(given) {
  const real = readUpgradeToken();
  if (!real || typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(real, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 重启某个 unit。门户自己不能直接重启自己（会被自己的 cgroup 杀掉），
 * 所以交给 systemd-run 起一个独立的一次性单元，延迟 3 秒执行。
 * @param {string} unit unit 名
 * @returns {Promise<{ok:boolean, output:string}>} 结果
 */
async function restartUnit(unit) {
  if (unit === 'portal.service') {
    const res = await run('sudo', ['-n', '/usr/bin/systemd-run',
      '--on-active=3', '--unit=portal-self-restart', '--collect',
      '/usr/bin/systemctl', 'restart', unit], 8000);
    return { ok: res.ok, output: lastLine(res.stderr) || res.error || '' };
  }
  const res = await run('sudo', ['-n', '/usr/bin/systemctl', 'restart', unit], 25000);
  return { ok: res.ok, output: lastLine(res.stderr) || res.error || '' };
}

/**
 * 读并解析 JSON 请求体。限 64KB，够用且防滥用。
 * @param {http.IncomingMessage} req 请求
 * @returns {Promise<object|null>} 解析结果，失败为 null
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * 执行一次升级：校验 → ff 合并 → 重启服务。
 * @param {object} body {id, token}
 * @returns {Promise<{status:number, body:object}>} HTTP 状态与响应体
 */
async function doUpgrade(body) {
  if (!readUpgradeToken()) {
    return { status: 503, body: { ok: false, error: '还没设置升级口令（' + TOKEN_FILE + '），功能未启用' } };
  }
  if (!tokenMatches(body && body.token)) {
    return { status: 401, body: { ok: false, error: '口令不对' } };
  }

  const target = versionTargets().filter((a) => a.id === (body && body.id))[0];
  if (!target) return { status: 404, body: { ok: false, error: '没有这个应用' } };
  if (!target.unit) return { status: 400, body: { ok: false, error: '这个应用没有配置 systemd 服务名' } };

  // 重新探一次，别信缓存：用户点升级前可能刚有人 push
  const st = await probeVersion(target);
  if (!st.managed) return { status: 400, body: { ok: false, error: st.error || '未纳入版本管理' } };
  if (!st.fetched) return { status: 502, body: { ok: false, error: st.error || '拉取镜像失败' } };
  if (st.dirty) {
    return { status: 409, body: { ok: false, error: '这个项目有未提交改动，先处理再升级（git status 看看）' } };
  }
  if (st.ahead > 0) {
    return { status: 409, body: { ok: false, error: '本地有 ' + st.ahead + ' 个没推送的提交，先推上去再升级' } };
  }
  if (!st.behind) {
    return { status: 200, body: { ok: true, already: true, id: st.id, message: '已经是最新版本', version: st.current } };
  }

  const before = st.current;
  const merge = await run('git', ['-C', target.dir, 'merge', '--ff-only', st.remoteRef], 30000);
  if (!merge.ok) {
    return { status: 500, body: { ok: false, error: '合并失败：' + (lastLine(merge.stderr) || merge.error) } };
  }

  const after = await run('git', ['-C', target.dir, 'log', '-1', '--format=%h%x00%s%x00%cI']);
  const parts = after.stdout.trim().split('\x00');
  versionsCache = { at: 0, value: null };

  const restarted = await restartUnit(target.unit);
  return {
    status: target.unit === 'portal.service' ? 202 : 200,
    body: {
      ok: true,
      id: st.id,
      name: st.name,
      from: before,
      to: { short: parts[0] || '?', subject: parts[1] || '', date: parts[2] || '' },
      applied: st.behind,
      restarted: restarted.ok,
      restartHint: restarted.ok ? null : ('代码已更新，但服务重启失败：' + restarted.output + '。请手动 sudo systemctl restart ' + target.unit),
      message: target.unit === 'portal.service'
        ? '已更新，门户将在 3 秒后重启'
        : '已更新并重启 ' + target.unit
    }
  };
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    console.error('[fatal] 处理请求时出错：' + (err && err.stack ? err.stack : err));
    try {
      sendText(res, 500, '服务器内部错误');
    } catch (ignored) {
      /* 响应已经发出去就没什么可做的了 */
    }
  }
});

// 端口被占之类的错误要打印人话，而不是扔一段残栈
server.on('error', (err) => {
  if (err && err.code === 'EACCES') {
    console.error('[启动失败] 没有权限绑定 ' + PORT + ' 端口。');
    console.error('  80 端口需要 CAP_NET_BIND_SERVICE：用 systemd unit 启动，或用 sudo，');
    console.error('  或者换端口：PORT=8080 node server.js');
  } else if (err && err.code === 'EADDRINUSE') {
    console.error('[启动失败] ' + PORT + ' 端口已被占用，换一个：PORT=8080 node server.js');
  } else {
    console.error('[启动失败] ' + (err && err.message ? err.message : err));
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const iface = pickIface();
  const shown = HOST === '0.0.0.0' ? (iface.ipv4 || '127.0.0.1') : HOST;
  console.log('门户已启动，监听 ' + HOST + ':' + PORT);
  console.log('  本机访问： http://127.0.0.1' + (PORT === 80 ? '' : ':' + PORT));
  console.log('  局域网：  http://' + shown + (PORT === 80 ? '' : ':' + PORT));
  console.log('  网卡：    ' + (iface.iface || '(未识别)') + '  应用：' + readConfig().apps.length + ' 个');

  // 先把三个 /proc 采样器预热好（各要一次 120ms 的现采），
  // 这样第一个 /api/stats 请求也是毫秒级，不用替启动过程付账。
  Promise.all([cpuUsage(), netRateOf(iface.iface), diskIo(DISK_DEV)])
    .then(() => {
      // NPU 和服务健康这两个慢采样器（npu-smi 一次约 470ms）也要等首轮出结果，
      // 否则横幅会把「还没采」说成「未检测到」。
      return waitFirstRound([samplers.npu, samplers.health], 5000);
    })
    .then(() => {
      console.log('  采样器：  CPU/网络/磁盘 已预热；' +
        'NPU ' + describeNpu(samplers.npu) +
        '；服务健康 ' + describeHealth(samplers.health));
    })
    .catch(() => { /* 预热失败不影响服务，/api/stats 会自己降级成 null */ });
});

process.on('SIGTERM', () => {
  console.log('收到 SIGTERM，关闭服务');
  server.close(() => { process.exit(0); });
});
