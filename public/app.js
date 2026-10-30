'use strict';

/**
 * 门户前端。零依赖、零 CDN —— 板子可能没有外网，页面必须完全自包含。
 *
 * 三条纪律：
 *   1. 服务端在非 Linux 环境会给一堆 null（读不到 /proc、没有 npu-smi），这里所有取值
 *      都过 isNum()，null / undefined / 字符串一律显示「—」，绝不让 NaN 出现在页面上；
 *   2. 请求失败只弹顶部窄条，卡片区保留上一次的数据 —— 断网时页面还能当书签用；
 *   3. 贵的指标（NPU、失败服务、进程 TOP）是服务端后台采样的，前端照旧 3 秒轮询，
 *      不因为多了几个字段就多发请求。
 */

(function () {
  /** 轮询间隔（毫秒）。 */
  var POLL_MS = 3000;
  /** 单个请求的超时：板子卡死时不要挂着一个永远不返回的 fetch。 */
  var TIMEOUT_MS = 5000;
  /** 备份超过这么多小时就变黄（说明每天 03:00 的定时任务可能断了）。 */
  var BACKUP_WARN_HOURS = 30;

  /** 卡片节点缓存：id → { badge, lat, sub }，轮询时只改状态，不重建 DOM。 */
  var appNodes = {};
  /** 每核 CPU 的节点缓存，核数变了才重建。 */
  var coreRows = [];
  /** 是否正在请求，避免上一轮没回来又发一轮。 */
  var busy = false;
  /** 上一次是否处于失败态，用来避免反复触发同一条提示。 */
  var offlineShown = false;

  /**
   * 取元素。
   * @param {string} id 元素 id
   * @returns {HTMLElement|null} 元素或 null
   */
  function $(id) { return document.getElementById(id); }

  /**
   * 是不是一个能参与运算的数字。字符串、NaN、Infinity 都不算。
   * @param {*} n 待判断的值
   * @returns {boolean} 是否有效数字
   */
  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  /**
   * 写文本，值没变就不动 DOM（减少重排）。
   * @param {HTMLElement|null} el 目标元素
   * @param {string} text 文本
   * @returns {void}
   */
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  /**
   * 字节数转人话。
   * @param {number|null} n 字节
   * @returns {string} 例如 "7.4 GB"，取不到时 "—"
   */
  function fmtBytes(n) {
    if (!isNum(n) || n < 0) return '—';
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return Math.round(n) + ' B';
  }

  /**
   * 每秒字节数转人话。
   * @param {number|null} n 字节/秒
   * @returns {string} 例如 "1.2 MB/s"，取不到时 "—"
   */
  function fmtRate(n) {
    if (!isNum(n) || n < 0) return '—';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB/s';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB/s';
    return Math.round(n) + ' B/s';
  }

  /**
   * 百分比文字。
   * @param {number|null} n 百分比
   * @returns {string} 例如 "12%"，取不到时 "—"
   */
  function fmtPct(n) {
    if (!isNum(n)) return '—';
    return Math.round(Math.max(0, Math.min(100, n))) + '%';
  }

  /**
   * 运行时长转人话（顶部主机用，带「已运行」）。
   * @param {number|null} sec 秒
   * @returns {string} 例如 "已运行 3 天 4 小时"
   */
  function fmtUptime(sec) {
    if (!isNum(sec) || sec < 0) return '—';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return '已运行 ' + d + ' 天 ' + h + ' 小时';
    if (h > 0) return '已运行 ' + h + ' 小时 ' + m + ' 分';
    return '已运行 ' + m + ' 分钟';
  }

  /**
   * 运行时长转短词（应用卡片里用，省地方）。
   * @param {number|null} sec 秒
   * @returns {string} 例如 "11 天"，取不到时 "—"
   */
  function fmtShortDuration(sec) {
    if (!isNum(sec) || sec < 0) return '—';
    if (sec < 60) return '不到 1 分钟';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时';
    return Math.floor(sec / 86400) + ' 天';
  }

  /**
   * 距今多久转人话（备份卡片用）。
   * @param {number|null} hours 小时数
   * @returns {string} 例如 "21 小时前"，取不到时 "—"
   */
  function fmtAgeHours(hours) {
    if (!isNum(hours) || hours < 0) return '—';
    if (hours < 1) return '刚刚';
    if (hours < 72) return Math.round(hours) + ' 小时前';
    return Math.round(hours / 24) + ' 天前';
  }

  /**
   * ISO 时间字符串转「MM-DD HH:mm」。
   * @param {string|null} iso ISO 时间
   * @returns {string} 例如 "10-30 03:00"，解析不了时 "—"
   */
  function fmtWhen(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /**
   * 用当前页面的主机名拼应用地址。
   * 必须用 location.hostname，不然换网段（192.168.x / 其他）就全废了。
   * @param {number} port 端口
   * @returns {string} 完整地址
   */
  function appUrl(port) {
    return location.protocol + '//' + location.hostname + ':' + port + '/';
  }

  /**
   * 带超时的 JSON 请求。
   * @param {string} url 地址
   * @returns {Promise<object>} 解析后的 JSON
   */
  function getJSON(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var opts = { cache: 'no-store', credentials: 'same-origin' };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (resp) {
      if (timer) clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  /**
   * 顶部离线窄条的显隐。
   * @param {boolean} on 是否显示
   * @returns {void}
   */
  function showOffline(on) {
    if (on === offlineShown) return;
    offlineShown = on;
    var bar = $('offline');
    if (bar) bar.hidden = !on;
  }

  /* ---------- 应用卡片 ---------- */

  /**
   * 造一张应用卡片。整张卡片是一个 <a>，手机上好点、也能中键新开。
   * @param {object} app 应用配置
   * @returns {{card:HTMLAnchorElement, badge:HTMLElement, lat:HTMLElement, sub:HTMLElement}}
   *   节点引用
   */
  function buildCard(app) {
    var card = document.createElement('a');
    card.className = 'app';
    card.href = appUrl(app.port);
    card.style.setProperty('--app-accent', app.accent || '#B4633A');
    card.setAttribute('aria-label', app.name + '，端口 ' + app.port);

    var top = document.createElement('span');
    top.className = 'app-top';
    var name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = app.name;
    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '检测中';
    top.appendChild(name);
    top.appendChild(badge);

    var desc = document.createElement('span');
    desc.className = 'app-desc';
    desc.textContent = app.desc || '';

    var foot = document.createElement('span');
    foot.className = 'app-foot';
    var port = document.createElement('span');
    port.className = 'app-port';
    port.textContent = ':' + app.port;
    var lat = document.createElement('span');
    lat.className = 'app-lat';
    foot.appendChild(port);
    foot.appendChild(lat);

    // 第三行小字：进程内存 / 已运行多久。取不到就整行留空。
    var sub = document.createElement('span');
    sub.className = 'app-sub';
    sub.hidden = true;

    // 内联 SVG，不引图标库
    var go = document.createElement('span');
    go.className = 'app-go';
    go.setAttribute('aria-hidden', 'true');
    go.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

    card.appendChild(top);
    card.appendChild(desc);
    card.appendChild(foot);
    card.appendChild(sub);
    card.appendChild(go);

    return { card: card, badge: badge, lat: lat, sub: sub };
  }

  /**
   * 首屏渲染应用卡片。
   * @param {object[]} apps 应用清单（不含实时状态）
   * @returns {void}
   */
  function renderApps(apps) {
    var box = $('apps');
    var empty = $('apps-empty');
    if (!box) return;
    appNodes = {};
    box.innerHTML = '';
    if (!apps || !apps.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    apps.forEach(function (app) {
      var built = buildCard(app);
      appNodes[app.id] = built;
      box.appendChild(built.card);
    });
  }

  /**
   * 根据轮询结果刷新卡片的在线状态、延迟、内存与运行时长。
   * @param {object[]} list /api/stats 里的 apps
   * @returns {void}
   */
  function paintApps(list) {
    (list || []).forEach(function (state) {
      var node = appNodes[state.id];
      if (!node) return;
      var up = !!state.up;
      var cls = 'badge ' + (up ? 'is-up' : 'is-down');
      if (node.badge.className !== cls) node.badge.className = cls;
      setText(node.badge, up ? '在线' : '离线');
      if (up && isNum(state.latencyMs)) setText(node.lat, state.latencyMs + ' ms');
      else setText(node.lat, up ? '' : '没响应');

      var bits = [];
      if (isNum(state.rssBytes)) bits.push('内存 ' + fmtBytes(state.rssBytes));
      if (isNum(state.uptimeSec)) bits.push('运行 ' + fmtShortDuration(state.uptimeSec));
      if (node.sub) {
        var text = bits.join(' · ');
        setText(node.sub, text);
        node.sub.hidden = !text;
      }
    });
  }

  /* ---------- 状态卡 ---------- */

  /**
   * 画一条进度条 + 分级颜色 + 脚注。
   * @param {string} key 卡片 data-key
   * @param {string} barId 进度条 id
   * @param {string} pctId 百分比文字 id
   * @param {string} footId 脚注 id
   * @param {number|null} value 百分比
   * @param {string} footText 脚注文字
   * @returns {void}
   */
  function paintMeter(key, barId, pctId, footId, value, footText) {
    var card = document.querySelector('.meter[data-key="' + key + '"]');
    var bar = $(barId);
    if (!isNum(value)) {
      setText($(pctId), '—');
      if (bar) bar.style.width = '0%';
      setText($(footId), footText);
      if (card) card.className = 'card meter';
      return;
    }
    var v = Math.max(0, Math.min(100, value));
    setText($(pctId), Math.round(v) + '%');
    if (bar) bar.style.width = v + '%';
    var level = v > 85 ? ' is-bad' : (v > 70 ? ' is-warn' : '');
    if (card) card.className = 'card meter' + level;
    setText($(footId), footText);
  }

  /**
   * 画每核 CPU 占用条。核数变了才重建 DOM。
   * @param {number[]|null} perCore 每核百分比
   * @returns {void}
   */
  function paintCores(perCore) {
    var box = $('cpu-cores');
    if (!box) return;
    var list = Array.isArray(perCore) ? perCore : [];
    if (!list.length) {
      box.innerHTML = '';
      coreRows = [];
      return;
    }
    while (coreRows.length < list.length) {
      var row = document.createElement('div');
      row.className = 'core-row';
      var name = document.createElement('span');
      name.textContent = '核' + coreRows.length;
      var barBox = document.createElement('span');
      barBox.className = 'core-bar';
      var fill = document.createElement('i');
      barBox.appendChild(fill);
      var val = document.createElement('span');
      val.className = 'core-val';
      row.appendChild(name);
      row.appendChild(barBox);
      row.appendChild(val);
      box.appendChild(row);
      coreRows.push({ row: row, fill: fill, val: val });
    }
    while (coreRows.length > list.length) {
      box.removeChild(box.lastChild);
      coreRows.pop();
    }
    for (var i = 0; i < list.length; i += 1) {
      var v = list[i];
      var node = coreRows[i];
      if (!isNum(v)) {
        node.fill.style.width = '0%';
        node.row.className = 'core-row';
        setText(node.val, '—');
        continue;
      }
      var c = Math.max(0, Math.min(100, v));
      node.fill.style.width = c + '%';
      node.row.className = 'core-row' + (c > 85 ? ' is-bad' : (c > 70 ? ' is-warn' : ''));
      setText(node.val, Math.round(c) + '%');
    }
  }

  /**
   * 画 NPU 卡。没有 NPU 时整块收起来，只留一句「未检测到 NPU」。
   * @param {object|null} npu NPU 快照
   * @returns {void}
   */
  function paintNpu(npu) {
    var body = $('npu-body');
    var none = $('npu-none');
    if (!npu) {
      if (body) body.hidden = true;
      if (none) none.hidden = false;
      setText($('npu-chip'), '—');
      return;
    }
    if (body) body.hidden = false;
    if (none) none.hidden = true;
    setText($('npu-chip'), npu.chip || '—');

    // AICore 占用
    var aicore = isNum(npu.aicorePct) ? npu.aicorePct : null;
    var aicoreBar = $('npu-aicore-bar');
    if (aicoreBar) aicoreBar.style.width = (aicore === null ? 0 : Math.max(0, Math.min(100, aicore))) + '%';
    setText($('npu-aicore'), aicore === null ? '—' : fmtPct(aicore));

    // 显存
    var used = isNum(npu.memUsedMB) ? npu.memUsedMB : null;
    var total = isNum(npu.memTotalMB) ? npu.memTotalMB : null;
    var memBar = $('npu-mem-bar');
    var memPct = (used !== null && total !== null && total > 0) ? (used / total) * 100 : null;
    if (memBar) memBar.style.width = (memPct === null ? 0 : Math.max(0, Math.min(100, memPct))) + '%';
    setText($('npu-mem'), (used === null || total === null)
      ? '—'
      : used + ' / ' + total + ' MB');

    // 健康 / 温度 / 功耗，全部灰色小字。刻意不做成红灯：Faulty Chip Count = 0、功耗 0W、
    // AICore 0%，大概率是空载常态，做成告警会让人天天看到而麻木。
    var notes = [];
    if (npu.health) {
      notes.push('健康 ' + npu.health +
        (isNum(npu.faultyChips) ? '（故障芯片 ' + npu.faultyChips + '）' : ''));
    }
    if (isNum(npu.tempC)) notes.push(npu.tempC + ' °C');
    if (isNum(npu.powerW)) notes.push('功耗 ' + npu.powerW + ' W');
    if (npu.stale) notes.push('数据稍旧');
    setText($('npu-note'), notes.length ? notes.join(' · ') : '—');
  }

  /**
   * 画服务健康卡。三态，颜色必须能区分：
   *   checked === false          → 灰色「无法检查」（查不了 ≠ 没问题）
   *   checked === true, 0 个失败  → 绿色「全部正常」+ 角标「0 个」
   *   有失败项                    → 角标「N 个」+ 可展开列出 unit
   * @param {object|null} health { checked:boolean, failedUnits:string[] }
   * @returns {void}
   */
  function paintHealth(health) {
    var units = (health && Array.isArray(health.failedUnits)) ? health.failedUnits : [];
    var checked = !!(health && health.checked);
    var card = document.querySelector('.meter[data-key="health"]');
    var ok = $('health-ok');
    var details = $('health-details');
    var list = $('health-list');

    // 有失败项时角标转红：这是真故障，不是「可能空载」那种可以含糊的情况
    if (card) card.className = 'card meter' + (checked && units.length ? ' is-bad' : '');

    // 查不了：灰色，绝不绿
    if (!checked) {
      setText($('health-count'), '—');
      if (ok) {
        ok.hidden = false;
        ok.className = 'meter-foot is-unknown';
        setText(ok, '无法检查');
      }
      if (details) details.hidden = true;
      if (list) list.innerHTML = '';
      return;
    }

    setText($('health-count'), units.length ? units.length + ' 个' : '0 个');

    if (!units.length) {
      if (ok) {
        ok.hidden = false;
        ok.className = 'meter-foot is-ok';
        setText(ok, '全部正常');
      }
      if (details) details.hidden = true;
      if (list) list.innerHTML = '';
      return;
    }
    if (ok) ok.hidden = true;
    if (details) details.hidden = false;
    if (list) {
      list.innerHTML = '';
      units.forEach(function (unit) {
        var li = document.createElement('li');
        li.textContent = unit;
        list.appendChild(li);
      });
    }
  }

  /**
   * 画进程 TOP。
   * @param {object[]|null} top [{comm,rssBytes}]
   * @returns {void}
   */
  function paintTop(top) {
    var box = $('top-list');
    var none = $('top-none');
    var list = Array.isArray(top) ? top : [];
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) {
      if (none) none.hidden = false;
      return;
    }
    if (none) none.hidden = true;
    list.forEach(function (p) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.className = 'tp-name';
      name.textContent = p && p.comm ? String(p.comm) : '—';
      var size = document.createElement('span');
      size.className = 'tp-size';
      size.textContent = fmtBytes(p ? p.rssBytes : null);
      li.appendChild(name);
      li.appendChild(size);
      box.appendChild(li);
    });
  }

  /**
   * 画备份卡。没有配置或目录为空时整张卡不显示。
   * @param {object|null} backup { label, lastAt, ageHours }
   * @returns {void}
   */
  function paintBackup(backup) {
    var card = document.querySelector('.meter[data-key="backup"]');
    if (!card) return;
    if (!backup) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    setText($('backup-label'), backup.label || '备份');
    setText($('backup-age'), fmtAgeHours(backup.ageHours));
    setText($('backup-at'), '最近一次 ' + fmtWhen(backup.lastAt));
    var warn = isNum(backup.ageHours) && backup.ageHours > BACKUP_WARN_HOURS;
    card.className = 'card meter' + (warn ? ' is-warn' : '');
  }

  /**
   * 把一次 /api/stats 的结果画到页面上。
   * @param {object} d 接口返回
   * @returns {void}
   */
  function paint(d) {
    var host = d.host || {};
    var cpu = d.cpu || {};
    var mem = d.mem || {};
    var disk = d.disk || {};
    var net = d.net || {};

    setText($('hostname'), host.hostname || '—');
    setText($('uptime'), fmtUptime(host.uptimeSec));
    setText($('foot-distro'), host.distro || '—');
    setText($('foot-kernel'), host.kernel ? '内核 ' + host.kernel : '—');

    paintMeter('mem', 'mem-bar', 'mem-pct', 'mem-foot', mem.usedPct,
      isNum(mem.totalBytes) ? '已用 ' + fmtBytes(mem.usedBytes) + ' / ' + fmtBytes(mem.totalBytes) : '—');

    paintMeter('disk', 'disk-bar', 'disk-pct', 'disk-foot', disk.usedPct,
      isNum(disk.totalBytes)
        ? '已用 ' + fmtBytes(disk.usedBytes) + ' / ' + fmtBytes(disk.totalBytes) +
          '（可用 ' + fmtBytes(disk.freeBytes) + '）'
        : '—');
    setText($('disk-io'), '读 ' + fmtRate(disk.readBytesPerSec) + ' · 写 ' + fmtRate(disk.writeBytesPerSec));

    paintMeter('cpu', 'cpu-bar', 'cpu-pct', 'cpu-foot', cpu.usagePct,
      isNum(cpu.cores) ? cpu.cores + ' 核' : '—');
    paintCores(cpu.perCore);

    setText($('net-state'), net.state === 'up' ? '已连接' : '未连接');
    setText($('net-iface'), net.iface || '—');
    setText($('net-ip'), net.ipv4 || '—');
    setText($('net-rx'), '↓ ' + fmtRate(net.rxBytesPerSec));
    setText($('net-tx'), '↑ ' + fmtRate(net.txBytesPerSec));

    paintNpu(d.npu || null);
    paintHealth(d.health || null);
    paintTop(d.top || null);
    paintBackup(d.backup || null);

    paintApps(d.apps);
  }

  /* ---------- 轮询 ---------- */

  /**
   * 拉一次状态。失败只更新窄条，不动已有数据。
   * @returns {void}
   */
  function refresh() {
    if (busy) return;
    busy = true;
    getJSON('/api/stats').then(function (d) {
      busy = false;
      if (!d || d.ok === false) {
        showOffline(true);
        return;
      }
      showOffline(false);
      paint(d);
    }).catch(function () {
      busy = false;
      showOffline(true);
    });
  }

  /**
   * 启动：先拿应用清单渲染卡片，再开始轮询状态。
   * @returns {void}
   */
  function boot() {
    getJSON('/api/apps').then(function (d) {
      var apps = (d && d.apps) || [];
      if (d && d.title) {
        setText($('title'), d.title);
        document.title = d.title;
      }
      renderApps(apps);
    }).catch(function () {
      // 清单都拿不到，说明服务没起来；给一句提示，轮询仍会继续试
      var empty = $('apps-empty');
      if (empty) {
        empty.textContent = '应用清单读取失败，稍后自动重试';
        empty.hidden = false;
      }
    }).then(function () {
      refresh();
      setInterval(function () {
        if (document.hidden) return;      // 页面在后台就不打扰板子
        refresh();
      }, POLL_MS);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refresh();  // 回到前台立刻刷一次，不等下一轮
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
