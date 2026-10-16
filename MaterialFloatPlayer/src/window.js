/*
 * Material Float Player - \u60ac\u6d6e\u64ad\u653e\u5668\u7a97\u53e3
 *
 * \u8be5\u811a\u672c\u88ab\u6ce8\u5165\u5230\u7531\u4e3b\u7a97\u53e3\u901a\u8fc7 winhelper.launchWindow \u521b\u5efa\u7684\u72ec\u7acb\u7a97\u53e3\u9875\u9762\u91cc\u3002
 * \u9875\u9762\u4e0e\u7f51\u6613\u4e91\u4e3b\u7a97\u53e3\u540c\u6e90\uff08orpheus://orpheus\uff09\uff0c\u56e0\u6b64\u53ef\u4ee5\u76f4\u63a5\u901a\u8fc7 localStorage
 * \u4e0e\u4e3b\u7a97\u53e3\u4ea4\u6362\u6570\u636e\uff1b\u7a97\u53e3\u81ea\u8eab\u7684\u539f\u751f\u80fd\u529b\uff08\u7f6e\u9876\u3001\u62d6\u52a8\u3001\u5173\u95ed\uff09\u901a\u8fc7 channel \u8c03\u7528\u3002
 */
(function () {
  'use strict';

  // \u53ea\u6709\u5e26\u6807\u8bb0\u53c2\u6570\u7684\u7a97\u53e3\u624d\u521b\u5efa\u754c\u9762\uff0c\u907f\u514d\u5f71\u54cd\u5230\u7f51\u6613\u4e91\u81ea\u5df1\u7684\u9875\u9762\u3002
  if (!/[?&]mfplayer=1/.test(location.search)) return;

  var K_STATE = 'mfp.state';
  var K_LYRIC = 'mfp.lyric';
  var K_CMD = 'mfp.cmd';
  var K_CFG = 'mfp.cfg';
  var K_BEAT = 'mfp.beat';
  var K_UI = 'mfp.ui';
  var K_HIDE = 'mfp.hide';

  var ICONS = {
    prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    repeatOne: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
    order: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    note: 'M12 3v10.55A4 4 0 1014 17V7h4V3h-6z',
  };

  var MODE_ICON = {
    'type-repeat': 'repeat',
    'type-one': 'repeatOne',
    'type-random': 'shuffle',
    'type-order': 'order',
    'type-ai': 'heart',
  };
  var MODE_LABEL = {
    'type-repeat': '\u5217\u8868\u5faa\u73af',
    'type-one': '\u5355\u66f2\u5faa\u73af',
    'type-random': '\u968f\u673a\u64ad\u653e',
    'type-order': '\u987a\u5e8f\u64ad\u653e',
    'type-ai': '\u5fc3\u52a8\u6a21\u5f0f',
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function icon(name, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' +
      (ICONS[name] || ICONS.note) + '"></path></svg>';
  }

  function callNative(name, args, cb) {
    try {
      if (window.channel && typeof channel.call === 'function') {
        channel.call(name, cb || function () { }, args || []);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function reportUi(action) {
    writeJSON(K_UI, { act: action, ts: Date.now() });
  }

  var cfg = readJSON(K_CFG, {}) || {};
  var state = readJSON(K_STATE, null);
  var lyric = readJSON(K_LYRIC, null);
  // \u4e0a\u4e00\u6b21\u8fd0\u884c\u7559\u4e0b\u7684\u72b6\u6001\u53ef\u80fd\u5df2\u7ecf\u8fc7\u65f6\uff0c\u8d85\u8fc7 3 \u79d2\u5c31\u5f53\u4f5c\u65e0\u6548
  if (state && (!state.ts || Date.now() - state.ts > 3000)) state = null;
  var receivedAt = Date.now();
  var storedCmd = readJSON(K_CMD, null);
  var cmdSeq = (storedCmd && storedCmd.seq) ? storedCmd.seq : 0;
  var curLineKey = '';
  var curScrollKey = '';
  var titleKey = '';
  var titleTimer = 0;
  var titleToken = 0;
  var titleApplied = '';
  var TITLE_SCROLL_MS = 2600;   // \u5f00\u5934\u6eda\u5230\u5c3e\u90e8\u7684\u65f6\u957f
  var TITLE_HOLD_START = 5000;  // \u5f00\u5934\u505c\u7559\uff08\u5408\u4e00\u8d77\u5927\u7ea6 10 \u79d2\u6eda\u4e00\u6b21\uff09
  var TITLE_HOLD_END = 1600;    // \u5c3e\u90e8\u505c\u7559\u540e\u76f4\u63a5\u56de\u5230\u5f00\u5934

  var CX = 0.042;      // \u7a97\u53e3\u5706\u89d2\u534a\u5f84 / \u5bbd\u5ea6
  var AR = 0.35;       // \u7a97\u53e3\u9ad8\u5ea6 / \u5bbd\u5ea6

  function radiusPx() {
    var value = cfg && cfg.radius != null ? Number(cfg.radius) : 16;
    return clamp(Math.round(isFinite(value) ? value : 16), 0, 40);
  }

  var root = document.createElement('div');
  root.className = 'mfp';
  root.innerHTML = [
    '<style>',
    '.mfp,.mfp *{box-sizing:border-box;-webkit-user-select:none;user-select:none}',
    'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--surface,#1b1b1f)}',
    // \u5706\u89d2\u53ea\u4fdd\u7559\u7a97\u53e3\u81ea\u8eab\u90a3\u4e00\u5c42\uff08\u7cfb\u7edf\u533a\u57df\u88c1\u526a\uff09\uff0cCSS \u4e0d\u518d\u753b\u5706\u89d2\uff0c\u907f\u514d\u51fa\u73b0\u4e24\u5c42\u5706\u89d2
    '.mfp{position:relative;width:100%;height:100%;overflow:hidden;border-radius:var(--radius);',
    '  background:var(--surface);color:var(--on);cursor:grab;',
    '  box-shadow:inset 0 0 0 1px rgba(var(--ink,255,255,255),.08);',
    '  transition:color .6s ease;',
    '  font-family:"Segoe UI Variable Text","Microsoft YaHei UI","Segoe UI",system-ui,sans-serif;',
    '  display:flex;align-items:center;gap:calc(var(--w) * .028);padding:calc(var(--w) * .030);}',
    '.mfp:active{cursor:grabbing}',
    '.mfp .bg-fade{position:absolute;inset:0;opacity:0;pointer-events:none;z-index:0}',
    '.mfp .art,.mfp .body{position:relative;z-index:1}',
    '.mfp .art{position:relative;flex:0 0 auto;align-self:center;height:100%;aspect-ratio:1/1;',
    '  max-width:42%;border-radius:calc(var(--radius) * .60);',
    '  background:rgba(var(--ink,255,255,255),.08);display:flex;align-items:center;justify-content:center;',
    '  overflow:hidden;box-shadow:inset 0 0 0 1px rgba(var(--ink,255,255,255),.10)}',
    '.mfp .art svg{width:38%;height:38%;fill:currentColor;opacity:.5}',
    '.mfp .art img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}',
    '.mfp .body{flex:1 1 auto;min-width:0;align-self:stretch;display:flex;flex-direction:column;',
    '  justify-content:space-between;overflow:hidden}',
    '.mfp .head{min-width:0}',
    '.mfp .clip{overflow:hidden;position:relative}',
    '.mfp .clip > span{display:inline-block;white-space:nowrap;will-change:transform}',
    '.mfp .title{font-size:calc(var(--fs) * 1.18);font-weight:600;line-height:1.3;',
    '  -webkit-mask-image:none}',
    '.mfp .title.fade{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 14px,#000 calc(100% - 14px),transparent 100%);',
    '  mask-image:linear-gradient(90deg,transparent 0,#000 14px,#000 calc(100% - 14px),transparent 100%)}',
    '.mfp .artist{font-size:calc(var(--fs) * .78);line-height:1.35;margin-top:1px;opacity:.55;',
    '  overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.mfp .lyric{position:relative;height:calc(var(--fs) * 2.66);margin-top:3px}',
    '.mfp .ln{position:absolute;left:0;right:0;overflow:hidden}',
    '.mfp .ln > span{display:inline-block;white-space:nowrap;will-change:transform}',
    '.mfp .ln.fade{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%);',
    '  mask-image:linear-gradient(90deg,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%)}',
    '.mfp .ln.cur{top:0;font-size:var(--fs);font-weight:600;color:var(--accent);line-height:1.3;',
    '  transition:color .6s ease}',
    '.mfp .ln.sub{top:calc(var(--fs) * 1.38);font-size:calc(var(--fs) * .84);line-height:1.3}',
    '.mfp .ln.sub > span{opacity:.62}',
    '.mfp .ln.enter{animation:mfpIn .26s cubic-bezier(.2,.8,.2,1)}',
    '@keyframes mfpIn{from{opacity:0;transform:translateY(40%)}to{opacity:1}}',
    '.mfp .foot{display:flex;align-items:center;justify-content:space-between;gap:6px}',
    '.mfp .ctrl{display:flex;align-items:center;gap:calc(var(--w) * .015)}',
    '.mfp button{appearance:none;border:0;background:transparent;color:inherit;padding:0;cursor:pointer;',
    '  display:flex;align-items:center;justify-content:center;border-radius:50%;',
    '  width:calc(var(--fs) * 1.95);height:calc(var(--fs) * 1.95);transition:background-color .15s,transform .1s}',
    '.mfp button svg{width:58%;height:58%;fill:currentColor}',
    '.mfp button:hover{background:rgba(var(--ink,255,255,255),.16)}',
    '.mfp button:active{transform:scale(.92)}',
    '.mfp button.main{background-color:var(--accent);color:var(--accent-on);',
    '  width:calc(var(--fs) * 2.4);height:calc(var(--fs) * 2.4);',
    '  transition:background-color .6s ease,color .6s ease,transform .1s}',
    '.mfp button.main:hover{filter:brightness(1.08)}',
    '.mfp button.ghost{width:calc(var(--fs) * 1.7);height:calc(var(--fs) * 1.7);opacity:0;transition:opacity .18s}',
    '.mfp:hover button.ghost{opacity:.5}',
    '.mfp button.ghost:hover{opacity:1;background:rgba(var(--ink,255,255,255),.16)}',
    '.mfp .meta{display:flex;align-items:center;gap:4px;line-height:1}',
    '.mfp .time{font-size:calc(var(--fs) * .78);opacity:.55;font-variant-numeric:tabular-nums;white-space:nowrap}',
    // Progress bar sits on the very bottom edge: the card clips it with the same radius,
    // so both ends follow the rounded corner instead of stopping short of it.
    '.mfp .bar{position:absolute;left:0;right:0;bottom:0;height:3px;',
    '  background:rgba(var(--ink,255,255,255),.13);z-index:2}',
    '.mfp .bar i{display:block;height:100%;width:0;background-color:var(--accent);',
    '  transition:width .25s linear,background-color .6s ease}',
    '.mfp.nosong button{opacity:.4;pointer-events:none}',
    '.mfp.nosong button.ghost{pointer-events:auto;opacity:.5}',
    '.mfp.zen .ctrl{display:none}',
    '.mfp.zen .foot{justify-content:flex-end}',
    '</style>',
    '<div class="bg-fade"></div>',
    '<div class="art">', icon('note'), '<img alt="">', '</div>',
    '<div class="body">',
    '  <div class="head">',
    '    <div class="clip title"><span></span></div>',
    '    <div class="artist"></div>',
    '    <div class="lyric">',
    '      <div class="clip ln cur"><span></span></div>',
    '      <div class="clip ln sub"><span></span></div>',
    '    </div>',
    '  </div>',
    '  <div class="foot">',
    '    <div class="ctrl">',
    '      <button data-act="prev" title="\u4e0a\u4e00\u9996">', icon('prev'), '</button>',
    '      <button data-act="toggle" class="main" title="\u64ad\u653e / \u6682\u505c">', icon('play'), '</button>',
    '      <button data-act="next" title="\u4e0b\u4e00\u9996">', icon('next'), '</button>',
    '      <button data-act="mode" title="\u5207\u6362\u64ad\u653e\u6a21\u5f0f">', icon('shuffle'), '</button>',
    '    </div>',
    '    <div class="meta"><span class="time"></span>',
    '      <button data-act="close" class="ghost" title="\u5173\u95ed\u60ac\u6d6e\u64ad\u653e\u5668">',
    icon('close'), '</button></div>',
    '  </div>',
    '</div>',
    '<div class="bar"><i></i></div>',
  ].join('');

  var n = {};

  /* \u4e3b\u9898\u8272\u4ea4\u53c9\u6de1\u5165\uff1a\u6362\u6b4c\u65f6\u65e7\u80cc\u666f\u6e10\u9690\u3001\u65b0\u80cc\u666f\u6e10\u663e\uff0c\u63a7\u4ef6\u989c\u8272\u7528 CSS transition \u8fc7\u6e21 */
  var surfaceBase = '';
  var surfaceTarget = '';
  var surfaceTimer = 0;
  var surfaceToken = 0;

  function applySurface(gradient, instant) {
    if (!gradient || gradient === surfaceTarget) return;
    surfaceTarget = gradient;
    if (instant || !surfaceBase) {
      surfaceBase = gradient;
      document.documentElement.style.setProperty('--surface', gradient);
      n.bgFade.style.transition = 'none';
      n.bgFade.style.opacity = '0';
      return;
    }
    var token = ++surfaceToken;
    n.bgFade.style.transition = 'none';
    n.bgFade.style.backgroundImage = gradient;
    void n.bgFade.offsetWidth;
    n.bgFade.style.transition = 'opacity .65s ease';
    n.bgFade.style.opacity = '1';
    clearTimeout(surfaceTimer);
    surfaceTimer = setTimeout(function () {
      if (token !== surfaceToken) return;
      surfaceBase = gradient;
      document.documentElement.style.setProperty('--surface', gradient);
      n.bgFade.style.transition = 'none';
      n.bgFade.style.opacity = '0';
    }, 700);
  }

  function bind() {
    n.title = root.querySelector('.title');
    n.titleText = n.title.querySelector('span');
    n.artist = root.querySelector('.artist');
    n.art = root.querySelector('.art');
    n.cur = root.querySelector('.ln.cur');
    n.curText = n.cur.querySelector('span');
    n.sub = root.querySelector('.ln.sub');
    n.subText = n.sub.querySelector('span');
    n.playBtn = root.querySelector('button.main');
    n.modeBtn = root.querySelector('button[data-act="mode"]');
    n.time = root.querySelector('.time');
    n.fill = root.querySelector('.bar i');
    n.cover = root.querySelector('.art img');
    n.bgFade = root.querySelector('.bg-fade');

    n.cover.addEventListener('load', function () { n.cover.style.display = 'block'; });
    n.cover.addEventListener('error', function () { n.cover.style.display = 'none'; });

    root.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target.closest && ev.target.closest('button')) return;
      reportUi('drag');
      callNative('winhelper.dragWindow');
    });

    root.addEventListener('click', function (ev) {
      var btn = ev.target.closest && ev.target.closest('button');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      reportUi(act);
      if (act === 'close') {
        try { localStorage.setItem(K_BEAT, JSON.stringify({ ts: 0 })); } catch (e) { /* ignore */ }
        callNative('winhelper.destroyWindow', [], function () { });
        return;
      }
      cmdSeq = Math.max(Date.now(), cmdSeq + 1);
      writeJSON(K_CMD, { seq: cmdSeq, action: act, ts: Date.now() });
      if (act === 'mode') setTimeout(pullState, 200);
    });
  }

  // ---------------------------------------------------------------- \u51e0\u4f55

  /*
   * winhelper \u7684\u7a97\u53e3\u5c3a\u5bf8 / \u5750\u6807\u4f7f\u7528\u7269\u7406\u50cf\u7d20\uff0c\u800c\u9875\u9762\u91cc\u7684\u5750\u6807\u662f\u903b\u8f91\u50cf\u7d20\uff0c
   * \u4e24\u8005\u76f8\u5dee devicePixelRatio\u3002\u8fd9\u91cc\u7528"\u7533\u8bf7 -> \u6d4b\u91cf -> \u76f4\u63a5\u89e3\u51fa\u6bd4\u4f8b"\u7684\u65b9\u5f0f\u6821\u51c6\u4e00\u6b21\uff0c
   * \u4e4b\u540e\u7684\u5c3a\u5bf8\u8c03\u6574\u90fd\u80fd\u4e00\u6b21\u5230\u4f4d\uff0c\u907f\u514d\u6765\u56de\u8fc7\u51b2\u5bfc\u81f4\u7684\u95ea\u70c1\u3002
   */
  var geo = {
    wantW: 384,
    wantH: 134,
    scale: 0,
    lastReq: null,
    appliedKey: '',
    targetKey: '',
    timer: 0,
    fixes: 0,
  };
  var lastRectKey = '';

  function desiredTarget() {
    var sw = (window.screen && screen.availWidth) || 1280;
    var sh = (window.screen && screen.availHeight) || 720;
    var maxX = Math.max(0, sw - geo.wantW);
    var maxY = Math.max(0, sh - geo.wantH);
    var target = { x: sw - geo.wantW - 40, y: sh - geo.wantH - 40 };
    if (cfg && cfg.target && typeof cfg.target.x === 'number' && typeof cfg.target.y === 'number') {
      target = { x: cfg.target.x, y: cfg.target.y };
    }
    return { x: Math.round(clamp(target.x, 0, maxX)), y: Math.round(clamp(target.y, 0, maxY)) };
  }

  function targetKey() {
    var t = desiredTarget();
    return t.x + ',' + t.y + '|' + (cfg.alwaysOnTop !== false ? 1 : 0);
  }

  function syncGeometry(force) {
    geo.wantW = clamp(Math.round((cfg && cfg.width) || 384), 240, 760);
    geo.wantH = Math.round(geo.wantW * AR);
    geo.radius = radiusPx();
    if (force) {
      geo.appliedKey = '';
      geo.targetKey = '';
      geo.fixes = 0;
    }
    clearTimeout(geo.timer);
    geo.timer = setTimeout(applyGeometry, 40);
  }

  function applyGeometry() {
    if (!geo.scale) geo.scale = window.devicePixelRatio || 1;
    var target = desiredTarget();
    var sizeKey = geo.wantW + 'x' + geo.wantH + '@' + radiusPx();
    var tKey = targetKey();
    var needSize = sizeKey !== geo.appliedKey || Math.abs(window.innerWidth - geo.wantW) > 2;
    var needMove = tKey !== geo.targetKey;
    if (!needSize && !needMove) return;

    var send = function (rect) {
      var width = Math.round(geo.wantW * geo.scale);
      var height = Math.round(geo.wantH * geo.scale);
      var wantX = Math.round(target.x * geo.scale);
      var wantY = Math.round(target.y * geo.scale);
      var move = needMove;
      // \u5df2\u7ecf\u5728\u76ee\u6807\u4f4d\u7f6e\u9644\u8fd1\u5c31\u4e0d\u8981\u518d\u4e0b\u53d1\u4e00\u6b21\uff08\u91cd\u590d\u8bbe\u7f6e\u4f1a\u8ba9\u5706\u89d2\u88ab\u91cd\u65b0\u5e94\u7528\uff0c\u770b\u8d77\u6765\u95ea\u4e00\u4e0b\uff09
      if (move && rect && Math.abs(rect.x - wantX) <= 3 && Math.abs(rect.y - wantY) <= 3) move = false;
      if (!needSize && !move) {
        geo.appliedKey = sizeKey;
        geo.targetKey = tKey;
        return;
      }
      geo.appliedKey = sizeKey;
      geo.targetKey = tKey;
      var req = {
        x: move ? wantX : (rect ? rect.x : wantX),
        y: move ? wantY : (rect ? rect.y : wantY),
        width: width, height: height,
        topmost: cfg.alwaysOnTop !== false,
        // corner_size \u7528\u903b\u8f91\u50cf\u7d20\uff0c\u548c CSS \u7684 --radius \u4fdd\u6301\u4e00\u81f4\uff0c\u907f\u514d\u51fa\u73b0"\u4e24\u5c42\u5706\u89d2"
        corner_size: radiusPx(),
      };
      geo.lastReq = req;
      reportUi('geometry');
      callNative('winhelper.setWindowPosition', [req], function () {
        setTimeout(verifyGeometry, 400);
      });
    };

    callNative('winhelper.getWindowPosition', [], function (rect) { send(rect); });
  }

  function verifyGeometry() {
    var req = geo.lastReq;
    var aw = window.innerWidth;
    var ah = window.innerHeight;
    if (!req || aw <= 0 || geo.fixes > 1) return;
    if (Math.abs(aw - geo.wantW) <= 2 && Math.abs(ah - geo.wantH) <= 2) return;
    geo.fixes += 1;
    // \u7531"\u4e0a\u4e00\u6b21\u7533\u8bf7\u503c / \u5b9e\u9645\u503c"\u76f4\u63a5\u89e3\u51fa\u6bd4\u4f8b\uff0c\u4e0d\u518d\u53e0\u52a0\uff0c\u907f\u514d\u6765\u56de\u6296\u52a8
    var solved = req.width / aw;
    if (solved > 0.2 && solved < 5) {
      geo.scale = solved;
      geo.appliedKey = '';
      clearTimeout(geo.timer);
      geo.timer = setTimeout(applyGeometry, 60);
    }
  }

  // ---------------------------------------------------------------- \u6e32\u67d3

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function livePos() {
    if (!state) return 0;
    var pos = state.pos || 0;
    if (Number(state.play) === 1) pos += (Date.now() - receivedAt) / 1000;
    var dur = state.dur || 0;
    if (dur > 0 && pos > dur) pos = dur;
    return pos;
  }

  function lyricLines() {
    return (lyric && lyric.lines && lyric.lines.length) ? lyric.lines : null;
  }

  function lineIndexAt(lines, pos) {
    var lo = 0, hi = lines.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if ((lines[mid].t || 0) / 1000 <= pos) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return idx;
  }

  function lineText(line) {
    return (line && line.o) || '';
  }

  /* \u5355\u884c\u6b4c\u8bcd\uff1a\u592a\u957f\u65f6\u6309\u8be5\u53e5\u65f6\u957f\u6a2a\u5411\u6eda\u52a8\uff0c\u4e24\u7aef\u6e10\u9690 */
  function setCurrentLine(line, lineIndex, durationMs) {
    var text = lineText(line);
    var key = text + '|' + lineIndex;
    if (key !== curLineKey) {
      curLineKey = key;
      curScrollKey = '';
      n.curText.textContent = text;
      n.curText.style.transition = 'none';
      n.curText.style.transform = 'translateX(0)';
      n.cur.classList.remove('fade');
      n.cur.classList.remove('enter');
      void n.cur.offsetWidth;
      n.cur.classList.add('enter');
    }
    var overflow = n.curText.scrollWidth - n.cur.clientWidth;
    if (overflow <= 6) {
      if (curScrollKey) {
        curScrollKey = '';
        n.cur.classList.remove('fade');
        n.curText.style.transition = 'none';
        n.curText.style.transform = 'translateX(0)';
      }
      return;
    }
    // \u7528 4px \u7f51\u683c\u505a key\uff0c\u907f\u514d\u6392\u7248\u6296\u52a8 1px \u5c31\u628a\u6574\u53e5\u6b4c\u8bcd\u91cd\u65b0\u6eda\u4e00\u904d
    var scrollKey = key + '|' + Math.round(overflow / 4);
    if (scrollKey === curScrollKey) return;
    curScrollKey = scrollKey;
    var total = clamp(durationMs || 6000, 2600, 24000);
    var hold = Math.min(900, total * 0.16);
    var glide = Math.max(1800, total - hold * 2);
    n.curText.style.transition = 'none';
    n.curText.style.transform = 'translateX(0)';
    void n.curText.offsetWidth;
    setTimeout(function () {
      if (curScrollKey !== scrollKey) return;
      n.cur.classList.add('fade');
      n.curText.style.transition = 'transform ' + glide + 'ms linear';
      n.curText.style.transform = 'translateX(' + (-overflow) + 'px)';
      setTimeout(function () {
        if (curScrollKey !== scrollKey) return;
        n.cur.classList.remove('fade');
      }, glide);
    }, hold);
    reportUi('lyric-scroll:' + Math.round(overflow) + 'px/' + Math.round(total) + 'ms');
  }

  /* Long song title: normally shows the head, and every cycle glides to the tail once,
     then snaps back to the head (no reverse animation). */
  function setTitle(text) {
    if (text !== titleKey) {
      titleKey = text;
      titleToken += 1;
      titleApplied = '';
      clearTimeout(titleTimer);
      n.titleText.textContent = text;
      n.titleText.style.transition = 'none';
      n.titleText.style.transform = 'translateX(0)';
      n.title.classList.remove('fade');
    }
    var overflow = Math.round(n.titleText.scrollWidth - n.title.clientWidth);
    if (overflow <= 6) {
      if (titleApplied) {
        titleApplied = '';
        n.title.classList.remove('fade');
      }
      return;
    }
    if (titleApplied === String(overflow)) return;
    titleApplied = String(overflow);
    var token = titleToken;
    var shift = -overflow;
    var later = function (fn, delay) {
      titleTimer = setTimeout(function () {
        if (token === titleToken) fn();
      }, delay);
    };
    var cycle = function () {
      n.title.classList.add('fade');
      n.titleText.style.transition = 'transform ' + TITLE_SCROLL_MS + 'ms cubic-bezier(.4,0,.2,1)';
      n.titleText.style.transform = 'translateX(' + shift + 'px)';
      later(function () {
        // one pass to the tail, then straight back to the head - no rolling back
        n.titleText.style.transition = 'none';
        n.titleText.style.transform = 'translateX(0)';
        n.title.classList.remove('fade');
        later(cycle, TITLE_HOLD_START);
      }, TITLE_SCROLL_MS + TITLE_HOLD_END);
    };
    later(cycle, TITLE_HOLD_START);
    reportUi('title-scroll:' + overflow + 'px');
  }

  function setSubLine(line, nextLine) {
    var text = '';
    var isTranslation = false;
    if (cfg.translation !== false && line && line.tr) {
      text = line.tr;
      isTranslation = true;
    } else if (nextLine) {
      text = lineText(nextLine);
    }
    if (n.subText.textContent !== text) {
      // \u5148\u628a\u5b57\u4f53\u900f\u660e\u5ea6\u5b9a\u597d\u518d\u6362\u6587\u5b57\uff0c\u907f\u514d\u521a\u51fa\u73b0\u65f6\u88ab\u52a8\u753b\u91cd\u7f6e\u6210\u4e0d\u900f\u660e\u7684\u767d\u8272
      n.subText.style.opacity = isTranslation ? '0.72' : '0.62';
      n.subText.textContent = text;
      n.sub.classList.remove('enter');
      void n.sub.offsetWidth;
      n.sub.classList.add('enter');
    }
    n.subText.style.opacity = isTranslation ? '0.72' : '0.62';
  }

  function render() {
    var c = cfg || {};
    var width = window.innerWidth || c.width || 384;
    root.style.setProperty('--w', width + 'px');
    root.style.setProperty('--fs', (c.fontSize || 13) + 'px');
    root.style.setProperty('--radius', radiusPx() + 'px');
    applySurface('linear-gradient(135deg,' + (c.color || '#2b2740') + ' 0%,' +
      (c.colorAlt || '#191725') + ' 100%)', false);
    root.style.setProperty('--accent', c.accent || '#d0bcff');
    root.style.setProperty('--accent-on', c.accentOn || '#241a3d');
    root.style.setProperty('--on', c.onColor || '#ffffff');
    // Ink used by hairlines, hover fills and the progress track: white on dark surfaces, black on light.
    root.style.setProperty('--ink', c.ink || '255,255,255');
    root.style.opacity = c.opacity == null ? 1 : String(c.opacity);

    var hasSong = !!(state && state.id);
    root.classList.toggle('nosong', !hasSong);
    root.classList.toggle('zen', c.zen === true);

    if (hasSong) {
      setTitle(state.title || '');
      var sub = state.artists || '';
      if (state.album) sub += (sub ? ' \u00b7 ' : '') + state.album;
      n.artist.textContent = sub;
      document.title = state.title + (state.artists ? ' - ' + state.artists : '');
      if (state.cover && n.cover.getAttribute('src') !== state.cover) {
        n.cover.style.display = 'none';
        n.cover.setAttribute('src', state.cover);
      } else if (!state.cover && n.cover.getAttribute('src')) {
        n.cover.removeAttribute('src');
        n.cover.style.display = 'none';
      }
    } else {
      setTitle('Material \u64ad\u653e\u5668');
      n.artist.textContent = '\u7b49\u5f85\u7f51\u6613\u4e91\u5f00\u59cb\u64ad\u653e';
      document.title = 'Material \u64ad\u653e\u5668';
      n.cover.removeAttribute('src');
      n.cover.style.display = 'none';
    }

    var playing = !!(state && Number(state.play) === 1);
    n.playBtn.innerHTML = icon(!state || !state.id ? 'play' : (playing ? 'pause' : 'play'));
    n.playBtn.setAttribute('title', !state || !state.id ? '\u6682\u65e0\u6b4c\u66f2' :
      (playing ? '\u6b63\u5728\u64ad\u653e\uff08\u70b9\u51fb\u6682\u505c\uff09' :
        '\u5df2\u6682\u505c\uff08\u70b9\u51fb\u64ad\u653e\uff09'));
    n.modeBtn.innerHTML = icon(MODE_ICON[state && state.mode] || 'shuffle');
    n.modeBtn.setAttribute('title',
      (MODE_LABEL[state && state.mode] || '\u64ad\u653e\u6a21\u5f0f') + '\uff08\u70b9\u51fb\u5207\u6362\uff09');

    var pos = livePos();
    var dur = (state && state.dur) || 0;
    n.time.textContent = c.showTime === false ? '' : (fmtTime(pos) + ' / ' + fmtTime(dur));
    n.fill.style.width = dur > 0 ? Math.min(100, (pos / dur) * 100) + '%' : '0%';

    var lines = lyricLines();
    if (lines) {
      var idx = lineIndexAt(lines, pos);
      while (idx > 0 && !lineText(lines[idx])) idx -= 1;
      var next = idx + 1;
      while (next < lines.length && !lineText(lines[next])) next += 1;
      var line = lines[idx];
      var durationMs = line && line.d ? line.d : 0;
      setCurrentLine(line, idx, durationMs);
      setSubLine(line, next < lines.length ? lines[next] : null);
    } else if (lyric && lyric.none) {
      setCurrentLine({ o: '\u6682\u65e0\u6b4c\u8bcd' }, -1, 0);
      n.subText.textContent = '';
    }
  }

  function pullState() {
    var st = readJSON(K_STATE, null);
    if (st && st.ts !== (state && state.ts)) {
      state = st;
      receivedAt = Date.now();
    }
    var ly = readJSON(K_LYRIC, null);
    if (ly && ly.rev !== (lyric && lyric.rev)) lyric = ly;
  }

  function start() {
    document.body.appendChild(root);
    bind();
    render();
    syncGeometry(true);
    window.addEventListener('resize', function () {
      render();
    });
    window.addEventListener('storage', function (ev) {
      if (ev.key === K_STATE) {
        state = readJSON(K_STATE, null);
        receivedAt = Date.now();
        render();
      } else if (ev.key === K_LYRIC) {
        lyric = readJSON(K_LYRIC, null);
        render();
      } else if (ev.key === K_CFG) {
        cfg = readJSON(K_CFG, {}) || {};
        render();
        syncGeometry(false);
      } else if (ev.key === K_CMD) {
        var cmd = readJSON(K_CMD, null);
        if (cmd && cmd.action === 'close') {
          try { localStorage.setItem(K_BEAT, JSON.stringify({ ts: 0 })); } catch (e) { /* ignore */ }
          callNative('winhelper.destroyWindow', [], function () { });
        }
      }
    });
    setInterval(function () {
      pullState();
      render();
    }, 500);
    /*
     * \u7f6e\u9876\u4e0d\u9760\u8f6e\u8be2\uff1a\u60ac\u6d6e\u7a97\u672c\u6765\u5c31\u662f WS_EX_TOPMOST\uff08\u548c\u7f51\u6613\u4e91\u684c\u9762\u6b4c\u8bcd\u7a97\u53e3\u4e00\u6837\uff0c\u521b\u5efa\u65f6\u5b9a\u597d\u5c31\u4e0d\u518d\u52a8\uff09\uff0c
     * \u65e0\u8fb9\u6846 / \u7a97\u53e3\u5316\u7684\u6e38\u620f\u672c\u6765\u5c31\u5728\u5b83\u4e0b\u9762\u3002\u53ea\u6709\u5f53\u524d\u53f0\u771f\u7684\u662f\u4e00\u4e2a\u5168\u5c4f\u7a97\u53e3\u65f6\uff0c"\u5168\u5c4f\u6e38\u620f\u4e0a\u65b9\u663e\u793a"
     * \u624d\u4f1a\u8ba9\u4e3b\u7a97\u53e3\u90a3\u8fb9\u7684\u540e\u53f0\u811a\u672c\u7528 SWP_NOACTIVATE \u628a\u5b83\u91cd\u65b0\u63d0\u5230\u7f6e\u9876\u6863\u6700\u524d\u9762\u2014\u2014
     * \u4e0d\u62a2\u7126\u70b9\u3001\u4e0d\u6539\u53d8\u4f4d\u7f6e\uff0c\u6240\u4ee5\u4e0d\u4f1a\u628a\u6e38\u620f\u7a97\u53e3\u9876\u6389\u3002
     */
    setInterval(function () {
      callNative('winhelper.getWindowPosition', [], function (rect) {
        if (rect) {
          var radiusPhysical = Math.round(radiusPx() * (geo.scale || 1));
          var rectKey = Math.round(rect.x) + ',' + Math.round(rect.y) + ',' +
            Math.round(rect.width) + ',' + Math.round(rect.height) + '@' + radiusPhysical;
          if (rectKey !== lastRectKey) {
            lastRectKey = rectKey;
            // \u544a\u8bc9\u4e3b\u7a97\u53e3\u6700\u65b0\u4f4d\u7f6e\uff0c\u7528\u6765\u5173\u6389\u7f51\u6613\u4e91\u5728\u5468\u56f4\u753b\u7684\u9634\u5f71
            writeJSON(K_HIDE, {
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              r: Math.round(radiusPx() * (geo.scale || 1)), ts: Date.now(),
            });
          }
        }
        writeJSON(K_BEAT, {
          ts: Date.now(),
          api: rect || null,
          css: { width: window.innerWidth, height: window.innerHeight },
          dpr: window.devicePixelRatio || 1,
          geo: {
            want: geo.wantW + 'x' + geo.wantH,
            req: geo.lastReq ? geo.lastReq.width + 'x' + geo.lastReq.height : '-',
            scale: geo.scale ? Number(geo.scale.toFixed(4)) : 0,
          },
          anim: {
            titleX: Math.round(n.titleText.getBoundingClientRect().left - n.title.getBoundingClientRect().left),
            titleFade: n.title.classList.contains('fade'),
            lyricX: Math.round(n.curText.getBoundingClientRect().left - n.cur.getBoundingClientRect().left),
            lyricFade: n.cur.classList.contains('fade'),
          },
        });
      });
    }, 1500);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
