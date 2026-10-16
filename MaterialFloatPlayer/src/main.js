/*
 * MaterialFloatPlayer 2.x - 主窗口侧逻辑
 *
 * 这一版不再自己建悬浮窗。界面交给独立的 Python 进程（floating window/mfp_py）：
 * 它创建自己的半透明窗口，圆角是逐像素 alpha 的真实抗锯齿、阴影是轮廓的模糊，
 * 尺寸位置全用逻辑像素。插件这边只做只有它能做的事：
 *
 *   1. 读网易云自己的播放状态（歌曲、进度、播放模式）→ 写给悬浮窗
 *   2. 用 liblyric / LibEAPIRequest 拿歌词（含翻译、每句时长）→ 写给悬浮窗
 *   3. 收悬浮窗发来的控制命令，交给网易云自己的播放栏按钮执行
 *   4. 看着心跳，负责把 Python 进程拉起来 / 重启 / 让它退出
 *
 * 外观设置（颜色模式、白天模式、沉浸模式、宽度、圆角、字号、不透明度、阴影、
 * 置顶……）全在悬浮窗自己的设置窗口里，插件设置页只留和 Python 进程相关的东西。
 *
 * 桥接文件（都以状态文件路径为前缀）：
 *
 *   插件 -> Python：<bridge>        播放状态（每次 publishState，约 500ms）
 *                   <bridge>.lyric  歌词（变化时写一次）
 *                   <bridge>.ctl    控制：show / hide / reload / settings / quit
 *   Python -> 插件：<bridge>.cmd    控制：toggle / play / pause / next / prev / mode / close / quit
 *                   <bridge>.beat   心跳，用来判断它是不是还活着
 *
 * 注意 betterncm.fs.* 是包在 HTTP 上的**异步** API（readFileText / exists 返回 Promise）：
 * 读文件必须 .then，当成同步值用会静默拿到 null。写文件同样是异步的，写完就好。
 */
(function () {
  'use strict';

  var LOG_FILE = 'C:/betterncm/MaterialFloatPlayer.log';

  var DEFAULTS = {
    enabled: true,
    pythonAuto: false,        // 自动判断 / 用户手动选过之后就不再插手
    pythonPath: '',           // 留空 = PATH 里的 pythonw
    pythonScript: '',         // 留空 = 下面 PY_LAUNCHER_DEFAULT
    bridgeFile: '',           // 留空 = 下面 BRIDGE_DEFAULT_FILE
  };

  var BRIDGE_DEFAULT_FILE = 'C:/betterncm/mfp-bridge.json';
  var PY_LAUNCHER_DEFAULT = 'C:/Users/16268/Documents/ChatGPT/floating window/mfp.py';
  var PY_SHIM = 'C:/betterncm/MaterialFloatPlayer-python.cmd';

  var MODE_KIND = {
    'type-repeat': 'repeat',
    'type-one': 'one',
    'type-random': 'random',
    'type-order': 'order',
    'type-ai': 'ai',
  };

  var cfg = {};

  // ---------------------------------------------------------------- 小工具

  var logLines = [];
  var logDirty = false;

  function log(message) {
    try {
      logLines.push(new Date().toLocaleTimeString() + ' ' + message);
      if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
      logDirty = true;
    } catch (e) { /* ignore */ }
  }

  setInterval(function () {
    if (!logDirty) return;
    logDirty = false;
    try { betterncm.fs.writeFileText(LOG_FILE, logLines.join('\n')); } catch (e) { /* ignore */ }
  }, 1000);

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readCfg() {
    var out = {};
    for (var key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        out[key] = plugin.getConfig(key, DEFAULTS[key]);
      }
    }
    return out;
  }

  function saveCfg(patch) {
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        cfg[key] = patch[key];
        plugin.setConfig(key, patch[key]);
      }
    }
  }

  function bridgeOn() {
    return cfg.enabled !== false;
  }

  function bridgeFile() {
    return (cfg.bridgeFile || '').trim() || BRIDGE_DEFAULT_FILE;
  }

  function pythonExe() {
    return (cfg.pythonPath || '').trim() || 'pythonw';
  }

  function pythonScript() {
    return (cfg.pythonScript || '').trim() || PY_LAUNCHER_DEFAULT;
  }

  // ---------------------------------------------------------------- 播放状态

  function mmss(text) {
    if (!text) return 0;
    var parts = String(text).trim().split(':');
    var sec = 0;
    for (var i = 0; i < parts.length; i++) sec = sec * 60 + (parseFloat(parts[i]) || 0);
    return isFinite(sec) ? sec : 0;
  }

  function readPlaying() {
    try {
      return betterncm.ncm.getPlayingSong() || null;
    } catch (e) {
      return null;
    }
  }

  function readBar() {
    var bar = document.querySelector('#main-player');
    if (!bar) return { pos: 0, dur: 0, mode: '', playTitle: '', posText: '' };
    var now = bar.querySelector('.now');
    var all = bar.querySelector('.all');
    var modeEl = bar.querySelector('.type');
    var playEl = bar.querySelector('.btnp-play');
    var mode = '';
    if (modeEl) {
      var classes = String(modeEl.className || '').split(/\s+/);
      for (var i = 0; i < classes.length; i++) {
        if (/^type-/.test(classes[i])) { mode = classes[i]; break; }
      }
    }
    return {
      pos: mmss(now && now.textContent),
      posText: (now && now.textContent) || '',
      dur: mmss(all && all.textContent),
      mode: mode,
      playTitle: (playEl && playEl.getAttribute('title')) || '',
    };
  }

  /*
   * 播放状态判定：网易云内部的 playing.state 并不总与真实播放状态一致，
   * 这里用"播放进度是否在走动"来判定，最可靠；换歌后先按正在播放处理。
   */
  var playDetect = { lastPos: -1, lastChangeAt: 0, songId: 0, value: 1 };

  function detectPlayState(bar, songId) {
    var now = Date.now();
    if (bar.pos !== playDetect.lastPos) {
      playDetect.lastPos = bar.pos;
      playDetect.lastChangeAt = now;
    }
    if (songId && songId !== playDetect.songId) {
      playDetect.songId = songId;
      playDetect.value = 1;
      return playDetect.value;
    }
    playDetect.songId = songId || playDetect.songId;
    if (playDetect.value === 1) {
      if (now - playDetect.lastChangeAt > 2200) playDetect.value = 2;
    } else if (now - playDetect.lastChangeAt < 1200) {
      playDetect.value = 1;
    }
    return playDetect.value;
  }

  /* 我们自己点了播放/暂停后，先本地翻转一次，界面立刻有反馈 */
  function optimisticPlayFlip() {
    playDetect.value = playDetect.value === 1 ? 2 : 1;
    playDetect.lastChangeAt = Date.now();
    publishState();
  }

  /*
   * 播放栏只给出整秒（"0:48"），直接送出去的话进度条和秒数会每秒回跳一次。
   * 记住进度文字是什么时候变的，之后在这上面加经过的时间，就有连续的小数进度了。
   */
  var posSmooth = { text: '', base: 0, at: 0 };

  function smoothPosition(bar, playing) {
    var now = Date.now();
    if (bar.posText !== posSmooth.text) {
      posSmooth.text = bar.posText;
      posSmooth.base = bar.pos;
      posSmooth.at = now;
    }
    if (!playing) return posSmooth.base;
    return posSmooth.base + Math.min(Math.max(now - posSmooth.at, 0) / 1000, 1.2);
  }

  var lastSignature = '';

  function publishState() {
    var song = readPlaying();
    var data = (song && song.data) || null;
    var bar = readBar();
    var artists = (data && data.artists ? data.artists : []).map(function (artist) {
      return artist && artist.name;
    }).filter(Boolean).join(' / ');
    var cover = (data && data.album && data.album.picUrl) || '';
    var id = (data && data.id) || 0;
    var playing = detectPlayState(bar, id) === 1;
    var state = {
      v: 1,
      ts: Date.now(),
      id: id,
      key: id ? 'ncm:' + id
        : ((data && data.name) ? data.name + '|' + artists + '|' + ((data.album && data.album.name) || '') : ''),
      title: (data && data.name) || '',
      artists: artists,
      album: (data && data.album && data.album.name) || '',
      cover: cover,
      duration: bar.dur || (data && data.duration ? Math.round(data.duration / 1000) : 0),
      position: smoothPosition(bar, playing),
      playing: playing,
      modeKind: MODE_KIND[bar.mode] || '',
      playTitle: bar.playTitle,
    };
    var signature = state.id + '|' + state.playing + '|' + state.modeKind;
    if (signature !== lastSignature) {
      lastSignature = signature;
      log('状态: id=' + state.id + ' play=' + (state.playing ? 1 : 2) +
        ' mode=' + (state.modeKind || '-') + ' 进度=' + Math.round(state.position) + '/' + state.duration +
        ' 《' + (state.title || '-') + '》');
    }
    publishBridgeState(state);
    if (state.id) ensureLyrics(state.id);
  }

  // ---------------------------------------------------------------- 歌词

  function parseLrc(text) {
    var out = [];
    if (!text) return out;
    var re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var stamps = [];
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        var frac = m[3] || '';
        var ms = frac ? parseInt(frac.length === 2 ? frac + '0' : frac, 10) : 0;
        stamps.push((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000 + ms);
      }
      if (!stamps.length) continue;
      var content = line.replace(re, '').trim();
      for (var j = 0; j < stamps.length; j++) out.push({ time: stamps[j], lyric: content });
    }
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  function mergeTranslation(base, translation) {
    if (!translation || !translation.length) return base;
    for (var i = 0; i < translation.length; i++) {
      var best = null;
      for (var j = 0; j < base.length; j++) {
        if (!best || Math.abs(base[j].time - translation[i].time) < Math.abs(best.time - translation[i].time)) {
          best = base[j];
        }
      }
      if (best && Math.abs(best.time - translation[i].time) <= 1200) best.tr = translation[i].lyric;
    }
    return base;
  }

  /* 每句歌词的持续时间：用于决定滚动一遍的时长 */
  function fillDurations(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].d) {
        lines[i].d = lines[i + 1] ? Math.max(1200, lines[i + 1].t - lines[i].t) : 6000;
      }
    }
    return lines;
  }

  function fetchLyricsLiblyric(id) {
    var lp = window.loadedPlugins && loadedPlugins.liblyric;
    if (!lp) return null;
    var getLyricData = lp.getLyricData || (lp.mainPlugin && lp.mainPlugin.getLyricData);
    var parseLyric = lp.parseLyric || (lp.mainPlugin && lp.mainPlugin.parseLyric);
    if (typeof getLyricData !== 'function' || typeof parseLyric !== 'function') return null;
    return getLyricData(id).then(function (raw) {
      var parsed = parseLyric(
        (raw && raw.lrc && raw.lrc.lyric) || '',
        (raw && raw.tlyric && raw.tlyric.lyric) || '',
        (raw && raw.romalrc && raw.romalrc.lyric) || '',
        (raw && raw.yrc && raw.yrc.lyric) || ''
      );
      return fillDurations((parsed || []).map(function (line) {
        return {
          t: line.time,
          o: line.originalLyric || '',
          tr: line.translatedLyric || '',
          ro: line.romanLyric || '',
          d: line.duration || 0,
        };
      }));
    });
  }

  function fetchLyricsEapi(id) {
    var lib = window.loadedPlugins && loadedPlugins.LibEAPIRequest;
    if (!lib || typeof lib.eapiRequest !== 'function') return null;
    var domain = (window.APP_CONF && APP_CONF.domain) || 'https://music.163.com';
    return new Promise(function (resolve, reject) {
      lib.eapiRequest(domain + '/api/song/lyric/v1', {
        type: 'json',
        query: { id: id, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 },
        onload: resolve,
        onerror: reject,
      });
    }).then(function (raw) {
      var base = parseLrc(raw && raw.lrc && raw.lrc.lyric);
      mergeTranslation(base, parseLrc(raw && raw.tlyric && raw.tlyric.lyric));
      return fillDurations(base.map(function (line) {
        return { t: line.time, o: line.lyric, tr: line.tr || '', ro: '', d: 0 };
      }));
    });
  }

  var lyricId = 0;
  var lyricPending = false;

  function ensureLyrics(id) {
    if (!id || id === lyricId || lyricPending) return;
    lyricPending = true;
    var task = fetchLyricsLiblyric(id) || fetchLyricsEapi(id);
    if (!task) {
      lyricPending = false;
      publishBridgeLyric([], true);
      log('lyric: 没有可用的歌词数据源，请安装 liblyric 或 LibEAPIRequest 插件');
      return;
    }
    task.then(function (lines) {
      lines = (lines || []).filter(function (line) { return line && line.o; });
      lyricId = id;
      publishBridgeLyric(lines, !lines.length);
      var longest = lines.reduce(function (max, line) {
        return Math.max(max, (line.o || '').length);
      }, 0);
      log('lyric: id=' + id + ' lines=' + lines.length + ' 最长句=' + longest + '字');
    }).catch(function (err) {
      log('lyric: 获取失败 ' + err);
      publishBridgeLyric([], true);
    }).then(function () {
      lyricPending = false;
    });
  }

  // ---------------------------------------------------------------- 控制

  function simClick(selector) {
    var el = document.querySelector(selector);
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch (err) {
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (err2) {
        return false;
      }
    }
  }

  function togglePlay() {
    if (simClick('#main-player .btnp-play')) return;
    var song = readPlaying();
    var playing = song && Number(song.state) === 1;
    try {
      channel.call(playing ? 'audioplayer.pause' : 'audioplayer.play', function () { }, []);
    } catch (err) {
      log('控制: 播放/暂停失败 ' + err);
    }
  }

  function runCommand(action) {
    if (action === 'toggle') {
      togglePlay();
      log('控制: toggle');
      optimisticPlayFlip();
      return;
    }
    var ok = false;
    if (action === 'next') ok = simClick('#main-player .btnc-nxt');
    else if (action === 'prev') ok = simClick('#main-player .btnc-prv');
    else if (action === 'mode') ok = simClick('#main-player .type');
    if (!ok) log('控制: 未找到播放栏按钮（' + action + '）');
    else log('控制: ' + action);
  }

  // ---------------------------------------------------------------- 桥接

  var bridgeKey = '';
  var bridgeAlive = false;
  var bridgeCmdSeq = 0;
  var bridgeCtlSeq = 0;
  var bridgeLaunchAt = 0;
  var bridgeStartedAt = 0;
  var bridgeReadWarned = false;
  var bridgeBeatPending = false;
  var bridgeCmdPending = false;
  var userClosed = false;

  function bridgeWrite(suffix, payload) {
    try {
      betterncm.fs.writeFileText(bridgeFile() + suffix, JSON.stringify(payload));
    } catch (e) {
      log('桥接: 写 ' + suffix + ' 失败 ' + e);
    }
  }

  function bridgeRead(suffix) {
    var path = bridgeFile() + suffix;
    if (!betterncm.fs || typeof betterncm.fs.readFileText !== 'function') {
      if (!bridgeReadWarned) {
        bridgeReadWarned = true;
        log('桥接: 当前 BetterNCM 没有 betterncm.fs.readFileText，悬浮窗收不到命令');
      }
      return Promise.resolve(null);
    }
    var promise;
    try {
      promise = Promise.resolve(betterncm.fs.readFileText(path));
    } catch (e) {
      if (!bridgeReadWarned) {
        bridgeReadWarned = true;
        log('桥接: 读 ' + path + ' 失败 ' + e);
      }
      return Promise.resolve(null);
    }
    return promise.then(function (text) {
      try {
        return text ? JSON.parse(text) : null;
      } catch (e) {
        return null;      // 文件可能正好被写到一半
      }
    }, function (err) {
      if (!bridgeReadWarned) {
        bridgeReadWarned = true;
        log('桥接: 读 ' + path + ' 失败 ' + err);
      }
      return null;
    });
  }

  function existsAsync(path) {
    if (!betterncm.fs || typeof betterncm.fs.exists !== 'function') return Promise.resolve(false);
    try {
      return Promise.resolve(betterncm.fs.exists(path)).then(
        function (value) { return !!value; },
        function () { return false; }
      );
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function publishBridgeState(state) {
    if (!bridgeOn()) return;
    bridgeKey = state.key;
    bridgeWrite('', {
      v: 1,
      ts: state.ts,
      app: 'cloudmusic.exe',
      track: {
        key: state.key,
        id: state.id,
        title: state.title,
        artists: state.artists,
        album: state.album,
        duration: state.duration,
        cover: state.cover,
      },
      playing: state.playing,
      position: state.position,
      modeKind: state.modeKind,
      modeLabel: state.playTitle,
    });
  }

  function publishBridgeLyric(lines, none) {
    if (!bridgeOn() || !bridgeKey) return;
    bridgeWrite('.lyric', {
      key: bridgeKey,
      rev: Date.now(),
      lines: lines || [],
      none: !!none || !(lines && lines.length),
    });
  }

  function bridgeControl(action) {
    bridgeCtlSeq += 1;
    bridgeWrite('.ctl', { seq: bridgeCtlSeq, action: action, ts: Date.now() });
    log('桥接: -> ' + action);
  }

  function pollBridgeBeat() {
    if (bridgeBeatPending) return;      // 别堆请求
    bridgeBeatPending = true;
    bridgeRead('.beat').then(function (beat) {
      bridgeBeatPending = false;
      bridgeAlive = !!(beat && beat.ts && Date.now() - beat.ts < 7000);
      if (bridgeAlive) bridgeStartedAt = 0;
    });
  }

  function pollBridgeCommand() {
    if (!bridgeOn() || bridgeCmdPending) return;
    bridgeCmdPending = true;
    bridgeRead('.cmd').then(function (cmd) {
      bridgeCmdPending = false;
      if (!cmd || !cmd.seq || cmd.seq === bridgeCmdSeq) return;
      bridgeCmdSeq = cmd.seq;
      var action = String(cmd.action || '');
      log('桥接: <- ' + action);
      if (action === 'close') return;      // Python 那边自己藏窗口，这里只记一条
      if (action === 'quit') { userClosed = true; return; }
      runCommand(action);
    });
  }

  // ---------------------------------------------------------------- Python 进程

  function winPath(path) {
    return String(path).replace(/\//g, '\\');
  }

  /*
   * betterncm.app.exec 是原生实现，命令行怎么切分不好猜；所以固定走一个自己写出来的
   * .cmd 外壳：命令行里只有一个被引号包住的文件名，其余全在文件里，出问题也能直接双击复现。
   * 写文件是异步的，cmd 必须在文件落地之后才能跑，所以先等写完再 exec。
   */
  function launchPython(extra) {
    var text = [
      '@echo off',
      'rem MaterialFloatPlayer 生成：启动 Python 悬浮窗，%* 会原样透传',
      '"' + winPath(pythonExe()) + '" "' + winPath(pythonScript()) +
        '" --bridge "' + winPath(bridgeFile()) + '" %*',
    ].join('\r\n') + '\r\n';
    var command = 'cmd /c "' + winPath(PY_SHIM) + '"' + (extra ? ' ' + extra : '');
    var written;
    try {
      written = Promise.resolve(betterncm.fs.writeFileText(PY_SHIM, text));
    } catch (e) {
      log('桥接: 写外壳脚本失败 ' + e);
      written = Promise.resolve();
    }
    written.then(function () {
      betterncm.app.exec(command);
    }, function () {
      betterncm.app.exec(command);
    });
    return command;
  }

  function ensurePythonWindow() {
    if (bridgeAlive || userClosed) return;
    // 它自己启动要几秒，这期间别反复拉
    if (Date.now() - bridgeLaunchAt < 8000) return;
    bridgeLaunchAt = Date.now();
    if (!bridgeStartedAt) bridgeStartedAt = Date.now();
    try {
      log('桥接: 启动 ' + launchPython());
    } catch (e) {
      log('桥接: 启动失败 ' + e);
    }
  }

  function stopPythonWindow() {
    bridgeControl('quit');
    bridgeAlive = false;
    bridgeCmdSeq = 0;
  }

  function openPythonSettings() {
    try {
      launchPython('--settings');
    } catch (e) {
      log('桥接: 打开设置失败 ' + e);
    }
  }

  function restartPythonWindow() {
    stopPythonWindow();
    userClosed = false;
    bridgeLaunchAt = 0;
    bridgeStartedAt = 0;
    setTimeout(function () {
      ensurePythonWindow();
      bridgeControl('show');
    }, 900);
  }

  function detectPython() {
    var script = pythonScript();
    return existsAsync(script).then(function (found) {
      if (!found) {
        log('桥接: 没找到启动脚本 ' + script + '，悬浮窗不会出现');
        return false;
      }
      if ((cfg.pythonPath || '').trim()) return true;
      var venv = script.replace(/[\\/][^\\/]*$/, '') + '/.venv/Scripts/pythonw.exe';
      return existsAsync(venv).then(function (hasVenv) {
        if (hasVenv) {
          saveCfg({ pythonPath: venv });
          log('桥接: 使用虚拟环境解释器 ' + venv);
          return true;
        }
        log('桥接: 没找到虚拟环境的 pythonw，先按 PATH 里的 pythonw 试一次');
        return true;
      });
    });
  }

  // ---------------------------------------------------------------- 主循环

  function tick() {
    if (!bridgeOn()) return;
    pollBridgeBeat();
    if (bridgeAlive) return;
    ensurePythonWindow();
    // 拉了很久还是没心跳，把话说明白，别让用户对着空桌面发呆
    if (bridgeStartedAt && Date.now() - bridgeStartedAt > 25000) {
      bridgeStartedAt = 0;
      log('桥接: 25 秒内没有收到 Python 的心跳。手动跑一下 ' + PY_SHIM +
        ' 看报错，或把 Python 解释器路径填对（设置页）');
    }
  }

  var started = false;

  function start() {
    if (started) return;
    started = true;
    cfg = readCfg();
    log('plugin: 启动，网易云版本 ' + (window.APP_CONF && APP_CONF.appver) +
      '，悬浮窗' + (cfg.enabled !== false ? '启用' : '停用'));
    // 上一次运行留下的命令不要重复执行
    bridgeRead('.cmd').then(function (pending) {
      bridgeCmdSeq = pending && pending.seq ? pending.seq : 0;
    });
    // 第一次跑：自己判断一次解释器和启动脚本在不在
    if (!cfg.pythonAuto) {
      detectPython().then(function (ok) {
        saveCfg({ pythonAuto: true });
        log('桥接: 首次自动判断 -> ' + (ok ? '可以启动悬浮窗' : '找不到 Python，悬浮窗不会出现'));
      });
    }
    setTimeout(function () {
      publishState();
      tick();
    }, 2500);
    setInterval(publishState, 500);
    setInterval(pollBridgeCommand, 400);
    setInterval(tick, 4000);
  }

  // ---------------------------------------------------------------- 设置界面

  function buildConfig() {
    var box = document.createElement('div');
    box.style.cssText = 'padding:14px 18px;font-size:13px;line-height:1.7;max-width:640px;' +
      'display:flex;flex-direction:column;gap:12px;';

    function row(label, control) {
      var el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;';
      var name = document.createElement('span');
      name.textContent = label;
      el.appendChild(name);
      el.appendChild(control);
      box.appendChild(el);
      return el;
    }

    function checkbox(key, onChange) {
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = cfg[key] !== undefined ? !!cfg[key] : !!DEFAULTS[key];
      input.style.cssText = 'width:16px;height:16px;cursor:pointer';
      input.addEventListener('change', function () {
        var patch = {};
        patch[key] = input.checked;
        saveCfg(patch);
        if (onChange) onChange(input.checked);
      });
      return input;
    }

    function textField(key, placeholder) {
      var input = document.createElement('input');
      input.type = 'text';
      input.value = cfg[key] !== undefined ? cfg[key] : (DEFAULTS[key] || '');
      input.placeholder = placeholder;
      input.style.cssText = 'width:300px;padding:3px 8px;border-radius:6px;font-size:12px;' +
        'border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.06);color:inherit;';
      var commit = function () {
        var patch = {};
        patch[key] = input.value.trim();
        saveCfg(patch);
      };
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
      return input;
    }

    function button(text, onClick) {
      var el = document.createElement('a');
      el.className = 'u-ibtn5';
      el.textContent = text;
      el.style.cssText = 'display:inline-block;padding:5px 15px;cursor:pointer;border-radius:999px;' +
        'border:1px solid rgba(255,255,255,.24);';
      el.addEventListener('click', onClick);
      return el;
    }

    row('启用悬浮播放器', checkbox('enabled', function (value) {
      userClosed = !value;
      if (value) {
        ensurePythonWindow();
        bridgeControl('show');
      } else {
        stopPythonWindow();
      }
    }));
    row('Python 解释器', textField('pythonPath', '留空用 PATH 里的 pythonw'));
    row('Python 启动脚本', textField('pythonScript', '留空用 mfp.py 的默认路径'));
    row('桥接状态文件', textField('bridgeFile', '留空用 C:/betterncm/mfp-bridge.json'));

    var note = document.createElement('div');
    note.style.cssText = 'opacity:.55;font-size:12px;line-height:1.6;margin:2px 0 -2px;';
    note.textContent = '外观设置（背景颜色、白天模式、沉浸模式、宽度、圆角、歌词字号、' +
      '不透明度、置顶、阴影……）在悬浮窗自己的设置窗口里改。曲目、进度、播放模式和' +
      '歌词都直接读网易云，不需要选来源。';
    box.appendChild(note);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:2px;';
    actions.appendChild(button('打开悬浮窗设置', openPythonSettings));
    actions.appendChild(button('重启悬浮窗', restartPythonWindow));
    actions.appendChild(button('显示悬浮窗', function () {
      userClosed = false;
      ensurePythonWindow();
      bridgeControl('show');
    }));
    actions.appendChild(button('隐藏悬浮窗', function () {
      bridgeControl('hide');
    }));
    box.appendChild(actions);

    var tip = document.createElement('div');
    tip.style.cssText = 'opacity:.6;font-size:12px;line-height:1.6;';
    tip.textContent = '悬浮窗是一个独立的 Python 进程（floating window/mfp_py），' +
      '插件负责把播放状态、歌词推给它，并执行它发来的控制命令。' +
      '第一次启动会自动确认解释器和启动脚本；找不到时日志里会写明原因' +
      '（C:/betterncm/MaterialFloatPlayer.log）。';
    box.appendChild(tip);

    return box;
  }

  plugin.onLoad(function () {
    try {
      start();
    } catch (err) {
      log('plugin: 启动异常 ' + err);
    }
  });

  plugin.onConfig(function () {
    cfg = readCfg();
    return buildConfig();
  });
})();
