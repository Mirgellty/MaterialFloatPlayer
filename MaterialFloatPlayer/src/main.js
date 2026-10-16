/*
 * Material Float Player - 主窗口侧逻辑
 *
 * 1. 采集网易云的播放状态（歌曲、进度、播放模式）写入 localStorage 共享给悬浮窗
 * 2. 获取歌词（优先 liblyric 插件，其次 LibEAPIRequest 自行解析）
 * 3. 从专辑封面提取主色调，供悬浮窗作为背景色
 * 4. 创建 / 关闭 / 维护悬浮窗，并执行悬浮窗发来的播放控制命令
 * 5. 提供插件设置界面
 */
(function () {
  'use strict';

  var LOG_FILE = 'C:/betterncm/MaterialFloatPlayer.log';
  var PAGE = 'orpheus://orpheus/pub/module/main/music/list/index.html?mfplayer=1';

  var K_STATE = 'mfp.state';
  var K_LYRIC = 'mfp.lyric';
  var K_CMD = 'mfp.cmd';
  var K_CFG = 'mfp.cfg';
  var K_BEAT = 'mfp.beat';
  var K_UI = 'mfp.ui';
  var K_HIDE = 'mfp.hide';

  var DEFAULTS = {
    enabled: true,
    bgMode: 'album',
    customColor: '#6750a4',
    light: false,
    width: 384,
    radius: 16,
    fontSize: 13,
    opacity: 1,
    translation: true,
    showTime: true,
    alwaysOnTop: true,
    gameTop: true,
    shadow: true,
    zen: false,
  };

  var DEFAULT_ALBUM_COLOR = '#6750a4';
  var SHAPE_SCRIPT = 'C:/betterncm/MaterialFloatPlayer-winshape.ps1';
  /*
   * 悬浮窗的圆角和阴影都只能靠 Win32 的窗口区域（region）来控制，所以在需要时写一个小脚本执行：
   *
   *   1. 按设置的半径给悬浮窗本身设置圆角区域。网易云创建窗口时给的圆角半径和设置里的半径
   *      并不一致，两层圆角对不上就会出现"外层锯齿圆角"。这里统一成设置值，两边完全重合。
   *   2. 网易云会在悬浮窗四周摆一圈 OrpheusShadow 窗口画阴影，它们是矩形，四角不跟随卡片
   *      圆角。关闭阴影时把它们裁成空区域，开启时裁成贴合卡片圆角的环。
   */
  var SHAPE_SCRIPT_BODY = [
    'param([int]$x,[int]$y,[int]$w,[int]$h,[int]$r,[int]$s,[int]$g)',
    '',
    '# x/y/w/h: player rect, r: corner radius (physical px), s: 1 = show shadow / 0 = hide,',
    '# g: 1 = keep above a foreground fullscreen window / 0 = leave it alone. Keep this file ASCII-only.',
    '# Keep this file pure ASCII: it is executed by Windows PowerShell, which reads BOM-less files as ANSI.',
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Text;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    '',
    'public class MFShape {',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '  public delegate bool EnumProc(IntPtr h, IntPtr p);',
    '',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);',
    '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);',
    '  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);',
    '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);',
    '  [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int ew, int eh);',
    '  [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr dst, IntPtr s1, IntPtr s2, int mode);',
    '  [DllImport("gdi32.dll")] static extern int OffsetRgn(IntPtr rgn, int x, int y);',
    '  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);',
    '',
    '  const int RGN_AND = 1;',
    '  const int RGN_DIFF = 4;',
    '  const uint SWP_NOSIZE = 0x0001;',
    '  const uint SWP_NOMOVE = 0x0002;',
    '  const uint SWP_NOACTIVATE = 0x0010;',
    '  const uint SWP_NOSENDCHANGING = 0x0400;',
    '  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);',
    '',
    '  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {',
    '    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;',
    '  }',
    '',
    '  // Declare DPI awareness first: otherwise GetWindowRect returns scaled (virtualized) coordinates',
    '  // that never match the physical pixel rect passed in from the plugin.',
    '  public static void Init() {',
    '    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }',
    '  }',
    '',
    '  static List<IntPtr> OfProcess(string cls) {',
    '    var pids = new List<uint>();',
    '    foreach (var p in System.Diagnostics.Process.GetProcessesByName("cloudmusic")) pids.Add((uint)p.Id);',
    '    var list = new List<IntPtr>();',
    '    EnumWindows(delegate(IntPtr hw, IntPtr p) {',
    '      uint pid; GetWindowThreadProcessId(hw, out pid);',
    '      if (!pids.Contains(pid)) return true;',
    '      var sb = new StringBuilder(256);',
    '      if (GetClassName(hw, sb, 256) == 0) return true;',
    '      if (sb.ToString() == cls) list.Add(hw);',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return list;',
    '  }',
    '',
    '  // The player window itself: region radius follows the setting and matches the CSS radius.',
    '  public static void Card(int x, int y, int w, int h, int r) {',
    '    foreach (var hw in OfProcess("OrpheusBrowserHost")) {',
    '      RECT rc; if (!GetWindowRect(hw, out rc)) continue;',
    '      if (Math.Abs(rc.Left - x) > 4 || Math.Abs(rc.Top - y) > 4) continue;',
    '      int cw = rc.Right - rc.Left, ch = rc.Bottom - rc.Top;',
    '      IntPtr rgn = r > 0',
    '        ? CreateRoundRectRgn(0, 0, cw + 1, ch + 1, r * 2, r * 2)',
    '        : CreateRectRgn(0, 0, cw + 1, ch + 1);',
    '      SetWindowRgn(hw, rgn, true);',
    '    }',
    '  }',
    '',
    '  // The shadow windows around it: empty region when hidden, otherwise a ring',
    '  // (rounded outer rect minus the rounded card) so the shadow hugs the rounded corner.',
    '  public static void Shadow(int x, int y, int w, int h, int r, bool show) {',
    '    int pad = 26;',
    '    IntPtr outer = CreateRoundRectRgn(x - pad, y - pad, x + w + pad, y + h + pad, (r + pad) * 2, (r + pad) * 2);',
    '    foreach (var hw in OfProcess("OrpheusShadow")) {',
    '      if (!IsWindowVisible(hw)) continue;',
    '      RECT rc; if (!GetWindowRect(hw, out rc)) continue;',
    '      if (rc.Left < x - pad || rc.Top < y - pad || rc.Right > x + w + pad || rc.Bottom > y + h + pad) continue;',
    '      if (!show) {',
    '        SetWindowRgn(hw, CreateRectRgn(0, 0, 0, 0), true);',
    '        continue;',
    '      }',
    '      IntPtr ring = CreateRectRgn(rc.Left, rc.Top, rc.Right, rc.Bottom);',
    '      CombineRgn(ring, ring, outer, RGN_AND);',
    '      IntPtr inner = r > 0',
    '        ? CreateRoundRectRgn(x, y, x + w, y + h, r * 2, r * 2)',
    '        : CreateRectRgn(x, y, x + w, y + h);',
    '      CombineRgn(ring, ring, inner, RGN_DIFF);',
    '      DeleteObject(inner);',
    '      OffsetRgn(ring, -rc.Left, -rc.Top);',
    '      SetWindowRgn(hw, ring, true);',
    '    }',
    '    DeleteObject(outer);',
    '  }',
    '',
    '  // The widget is put back in front of the topmost band only while the foreground window',
    '  // covers a whole monitor (a game/video in fullscreen). SWP_NOACTIVATE means it never takes',
    '  // focus, so the game is not kicked out of fullscreen and keeps its input focus.',
    '  static bool IsFullscreen(IntPtr h) {',
    '    RECT rc; if (!GetWindowRect(h, out rc)) return false;',
    '    IntPtr mon = MonitorFromWindow(h, 2);   // MONITOR_DEFAULTTONEAREST',
    '    if (mon == IntPtr.Zero) return false;',
    '    var mi = new MONITORINFO();',
    '    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));',
    '    if (!GetMonitorInfo(mon, ref mi)) return false;',
    '    return rc.Left <= mi.rcMonitor.Left + 1 && rc.Top <= mi.rcMonitor.Top + 1 &&',
    '           rc.Right >= mi.rcMonitor.Right - 1 && rc.Bottom >= mi.rcMonitor.Bottom - 1;',
    '  }',
    '',
    '  public static void RaiseAboveFullscreen(int x, int y, int w, int h) {',
    '    IntPtr fg = GetForegroundWindow();',
    '    if (fg == IntPtr.Zero || !IsFullscreen(fg)) return;',
    '    foreach (var hw in OfProcess("OrpheusBrowserHost")) {',
    '      RECT rc; if (!GetWindowRect(hw, out rc)) continue;',
    '      if (Math.Abs(rc.Left - x) > 4 || Math.Abs(rc.Top - y) > 4) continue;',
    '      SetWindowPos(hw, HWND_TOPMOST, 0, 0, 0, 0,',
    '        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING);',
    '    }',
    '  }',
    '}',
    '\'@',
    '',
    '[MFShape]::Init()',
    '[MFShape]::Card($x, $y, $w, $h, $r)',
    '[MFShape]::Shadow($x, $y, $w, $h, $r, ($s -eq 1))',
    'if ($g -eq 1) { [MFShape]::RaiseAboveFullscreen($x, $y, $w, $h) }',
  ].join('\n');

  // ---------------------------------------------------------------- 小工具

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

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var v = m[1];
    if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    return {
      r: parseInt(v.substring(0, 2), 16),
      g: parseInt(v.substring(2, 4), 16),
      b: parseInt(v.substring(4, 6), 16),
    };
  }

  function rgbToHex(rgb) {
    var part = function (v) {
      var s = clamp(Math.round(v), 0, 255).toString(16);
      return s.length < 2 ? '0' + s : s;
    };
    return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
  }

  /*
   * 取色参考 Material You（Monet / HCT）的思路：先把颜色转到感知均匀的空间，
   * 把「色相 / 彩度 / 明度」拆开处理，再挑"占比高且够鲜艳"的那一族色相作为源色，
   * 最后按目标明度重新生成背景色与强调色（同一色相在明暗变化时观感最接近原图）。
   * 这里用 OkLab/OkLCh 近似 HCT，精度足够且实现简单。
   */
  function srgbToLinear(v) {
    v = v / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function linearToSrgbByte(v) {
    var s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return clamp(Math.round(s * 255), 0, 255);
  }

  function rgbToOklab(rgb) {
    var r = srgbToLinear(rgb.r), g = srgbToLinear(rgb.g), b = srgbToLinear(rgb.b);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
      L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    };
  }

  function oklabToRgb(lab) {
    var l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
    var m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
    var s_ = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;
    var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return {
      r: linearToSrgbByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: linearToSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: linearToSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    };
  }

  function oklabToLch(lab) {
    return {
      L: lab.L,
      C: Math.sqrt(lab.a * lab.a + lab.b * lab.b),
      h: Math.atan2(lab.b, lab.a),
    };
  }

  function lchToOklab(L, C, h) {
    return { L: L, a: C * Math.cos(h), b: C * Math.sin(h) };
  }

  function luminance(rgb) {
    var f = function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
  }

  /*
   * 把源色按 Material 的色调思路生成一套配色。
   * 深色：低彩度暗背景 + 高彩度亮强调色；浅色：高明度浅背景 + 中明度强调色。
   * 两种明暗用同一个色相，来回切换时观感一致。ink 是"纸面上画线用的墨色"，
   * 页面里的描边、悬停底色、进度条槽都用它（深色模式取白、浅色模式取黑）。
   */
  function buildPalette(baseRgb, keepSurface, light) {
    var lch = oklabToLch(rgbToOklab(baseRgb));
    var hue = lch.h;
    var chroma = lch.C;
    var surface, surfaceAlt, accent, onColor;

    if (light) {
      var lightL = keepSurface ? clamp(lch.L, 0.88, 0.97) : 0.955;
      var lightC = keepSurface ? clamp(chroma * 0.24, 0.006, 0.04) : clamp(chroma * 0.1, 0.005, 0.026);
      surface = oklabToRgb(lchToOklab(lightL, lightC, hue));
      surfaceAlt = oklabToRgb(lchToOklab(
        clamp(lightL - 0.055, 0.8, 0.93),
        clamp(lightC * 0.85, 0.005, 0.04), hue));
      accent = oklabToRgb(lchToOklab(
        0.52, clamp(Math.max(chroma * 1.05, 0.09), 0.07, 0.17), hue));
      onColor = rgbToHex(oklabToRgb(lchToOklab(
        0.3, clamp(chroma * 0.26, 0.008, 0.05), hue)));
    } else {
      var surfaceL = keepSurface ? clamp(lch.L, 0.24, 0.68) : 0.27;
      var surfaceC = keepSurface ? clamp(chroma * 0.9, 0.02, 0.13) : clamp(chroma * 0.5, 0.02, 0.07);
      surface = oklabToRgb(lchToOklab(surfaceL, surfaceC, hue));
      surfaceAlt = oklabToRgb(lchToOklab(
        Math.max(0.12, surfaceL - 0.09),
        clamp(surfaceC * 0.8, 0.015, 0.13), hue));
      accent = oklabToRgb(lchToOklab(
        0.86, clamp(Math.max(chroma * 1.15, 0.08), 0.05, 0.17), hue));
      onColor = luminance(surface) > 0.42 ? '#1b1b1f' : '#ffffff';
    }

    return {
      color: rgbToHex(surface),
      colorAlt: rgbToHex(surfaceAlt),
      accent: rgbToHex(accent),
      accentOn: luminance(accent) > 0.5 ? '#221a35' : '#ffffff',
      onColor: onColor,
      ink: light ? '0,0,0' : '255,255,255',
    };
  }

  // ---------------------------------------------------------------- 配置

  var cfg = {};

  function readCfg() {
    var out = {};
    for (var key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        out[key] = plugin.getConfig(key, DEFAULTS[key]);
      }
    }
    out.pos = plugin.getConfig('pos', null);
    return out;
  }

  function saveCfg(patch) {
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        cfg[key] = patch[key];
        plugin.setConfig(key, patch[key]);
      }
    }
    publishTheme();
  }

  // ---------------------------------------------------------------- 播放状态

  // 缓存的是封面主色本身，而不是某一套配色：切换白天/夜晚时按同一个源色重新生成
  var albumRgb = null;
  var colorTaskId = 0;
  var lyricId = 0;
  var lyricPending = false;
  var lastCmdSeq = 0;
  var sawLiveWindow = false;
  var userClosed = false;
  var loggedGeometry = '';
  var lastUiEvent = 0;
  var lastSignature = '';
  var lastLaunchAt = 0;
  var lastPlayHtml = '';

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
    if (!bar) return { pos: 0, dur: 0, mode: '', playTitle: '' };
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

  function publishState() {
    var song = readPlaying();
    var data = (song && song.data) || null;
    var bar = readBar();
    var artists = (data && data.artists ? data.artists : []).map(function (artist) {
      return artist && artist.name;
    }).filter(Boolean).join(' / ');
    var cover = (data && data.album && data.album.picUrl) || '';
    var state = {
      v: 1,
      ts: Date.now(),
      id: (data && data.id) || 0,
      title: (data && data.name) || '',
      artists: artists,
      album: (data && data.album && data.album.name) || '',
      cover: cover,
      dur: bar.dur || (data && data.duration ? Math.round(data.duration / 1000) : 0),
      pos: bar.pos,
      play: detectPlayState(bar, (data && data.id) || 0),
      playTitle: bar.playTitle,
      mode: bar.mode,
      lyricRev: lyricId,
    };
    writeJSON(K_STATE, state);
    var signature = state.id + '|' + state.play + '|' + state.mode;
    if (signature !== lastSignature) {
      lastSignature = signature;
      log('状态: id=' + state.id + ' play=' + state.play + ' mode=' + state.mode +
        ' 播放栏=' + (state.playTitle || '-') + ' 进度=' + state.pos + '/' + state.dur +
        ' 《' + (state.title || '-') + '》');
    }
    if (state.id) {
      ensureLyrics(state.id);
      ensureColor(state.id, state.cover);
    }
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

  function ensureLyrics(id) {
    if (!id || id === lyricId || lyricPending) return;
    lyricPending = true;
    var task = fetchLyricsLiblyric(id) || fetchLyricsEapi(id);
    if (!task) {
      lyricPending = false;
      writeJSON(K_LYRIC, { id: id, rev: Date.now(), lines: [], none: true });
      log('lyric: 没有可用的歌词数据源，请安装 liblyric 或 LibEAPIRequest 插件');
      return;
    }
    task.then(function (lines) {
      lines = (lines || []).filter(function (line) { return line && line.o; });
      lyricId = id;
      writeJSON(K_LYRIC, { id: id, rev: Date.now(), lines: lines, none: !lines.length });
      var longest = lines.reduce(function (max, line) {
        return Math.max(max, (line.o || '').length);
      }, 0);
      log('lyric: id=' + id + ' lines=' + lines.length + ' 最长句=' + longest + '字');
    }).catch(function (err) {
      log('lyric: 获取失败 ' + err);
      writeJSON(K_LYRIC, { id: id, rev: Date.now(), lines: [], none: true });
    }).then(function () {
      lyricPending = false;
    });
  }

  // ---------------------------------------------------------------- 取色

  function dominantColor(img) {
    var size = 48;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    var data = ctx.getImageData(0, 0, size, size).data;
    var buckets = {};
    var fallback = { L: 0, a: 0, b: 0, n: 0 };
    for (var i = 0; i < data.length; i += 4) {
      var lab = rgbToOklab({ r: data[i], g: data[i + 1], b: data[i + 2] });
      fallback.L += lab.L; fallback.a += lab.a; fallback.b += lab.b; fallback.n++;
      var lch = oklabToLch(lab);
      if (lab.L < 0.18 || lab.L > 0.92) continue;   // 去掉过黑/过白
      if (lch.C < 0.03) continue;                   // 去掉灰
      var key = Math.floor((((lch.h * 180 / Math.PI) + 360) % 360) / 15);
      var bucket = buckets[key] || (buckets[key] = { n: 0, L: 0, a: 0, b: 0, c: 0 });
      bucket.n += 1;
      bucket.L += lab.L; bucket.a += lab.a; bucket.b += lab.b; bucket.c += lch.C;
    }
    var best = null, bestScore = 0;
    for (var k in buckets) {
      if (!Object.prototype.hasOwnProperty.call(buckets, k)) continue;
      var bucket = buckets[k];
      if (!bucket.n) continue;
      // 占比高 + 够鲜艳 = 更像 Material You 挑出来的那个"主色"
      var score = Math.pow(bucket.n, 0.55) * Math.pow(bucket.c / bucket.n, 1.1);
      if (score > bestScore) {
        bestScore = score;
        best = bucket;
      }
    }
    if (best) {
      return oklabToRgb({ L: best.L / best.n, a: best.a / best.n, b: best.b / best.n });
    }
    if (fallback.n) {
      return oklabToRgb({
        L: fallback.L / fallback.n,
        a: fallback.a / fallback.n,
        b: fallback.b / fallback.n,
      });
    }
    return hexToRgb(DEFAULT_ALBUM_COLOR);
  }

  function ensureColor(id, cover) {
    if (!id || !cover || id === colorTaskId) return;
    colorTaskId = id;
    var cached = readJSON('mfp.rgb.' + id, null);
    if (cached) {
      albumRgb = cached;
      publishTheme();
      return;
    }
    var load = function (useCors) {
      var img = new Image();
      if (useCors) img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          albumRgb = dominantColor(img);
          writeJSON('mfp.rgb.' + id, albumRgb);
          publishTheme();
          log('color: id=' + id + ' -> ' + rgbToHex(albumRgb));
        } catch (err) {
          if (useCors) load(false);
          else log('color: 取色失败 ' + err);
        }
      };
      img.onerror = function () {
        if (useCors) load(false);
        else {
          albumRgb = null;
          log('color: 封面加载失败');
          publishTheme();
        }
      };
      img.src = cover;
    };
    load(true);
  }

  function resolvePalette() {
    var light = cfg.light === true;
    if (cfg.bgMode === 'custom') {
      return buildPalette(hexToRgb(cfg.customColor) || hexToRgb(DEFAULT_ALBUM_COLOR), true, light);
    }
    return buildPalette(albumRgb || hexToRgb(DEFAULT_ALBUM_COLOR), false, light);
  }

  function publishTheme() {
    var palette = resolvePalette();
    writeJSON(K_CFG, {
      width: clamp(cfg.width || DEFAULTS.width, 260, 720),
      radius: clamp(cfg.radius == null ? DEFAULTS.radius : cfg.radius, 0, 40),
      fontSize: cfg.fontSize || DEFAULTS.fontSize,
      opacity: cfg.opacity == null ? 1 : cfg.opacity,
      shadow: cfg.shadow !== false,
      translation: cfg.translation !== false,
      showTime: cfg.showTime !== false,
      alwaysOnTop: cfg.alwaysOnTop !== false,
      gameTop: cfg.gameTop !== false,
      light: cfg.light === true,
      zen: cfg.zen === true,
      bgMode: cfg.bgMode || DEFAULTS.bgMode,
      color: palette.color,
      colorAlt: palette.colorAlt,
      accent: palette.accent,
      accentOn: palette.accentOn,
      onColor: palette.onColor,
      ink: palette.ink || '255,255,255',
      target: (cfg.pos && typeof cfg.pos.x === 'number' && typeof cfg.pos.y === 'number')
        ? { x: cfg.pos.x, y: cfg.pos.y } : null,
    });
  }

  // ---------------------------------------------------------------- 悬浮窗

  function beat() {
    return readJSON(K_BEAT, null);
  }

  function windowAlive() {
    var b = beat();
    return !!(b && b.ts && Date.now() - b.ts < 7000);
  }

  function rememberPosition() {
    var b = beat();
    if (!b || !b.api || typeof b.api.x !== 'number' || typeof b.api.y !== 'number') return;
    var dpr = b.dpr || window.devicePixelRatio || 1;
    var logical = { x: Math.round(b.api.x / dpr), y: Math.round(b.api.y / dpr) };
    var saved = plugin.getConfig('pos', null);
    if (!saved || Math.abs(saved.x - logical.x) > 2 || Math.abs(saved.y - logical.y) > 2) {
      plugin.setConfig('pos', logical);
      cfg.pos = logical;
    }
  }

  /* 悬浮窗的圆角区域 + 网易云画在窗口四周的阴影窗口（OrpheusShadow），都在这个小脚本里处理，
     插件内部没有对应 API，只能经由 Win32 的窗口区域实现。 */
  var shapeTimer = 0;
  var shapeScriptWritten = false;
  var shapeRect = null;
  var lastShapeCallTs = 0;
  var lastHideTs = 0;

  function shapeSoon(delay) {
    clearTimeout(shapeTimer);
    shapeTimer = setTimeout(applyWindowShape, delay == null ? 900 : delay);
  }

  function applyWindowShape() {
    if (!shapeRect) return;
    var x = Math.round(shapeRect.x), y = Math.round(shapeRect.y);
    var w = Math.round(shapeRect.w), h = Math.round(shapeRect.h);
    var r = Math.max(0, Math.round(shapeRect.r || 0));
    if (!shapeScriptWritten) {
      shapeScriptWritten = true;
      try {
        betterncm.fs.writeFileText(SHAPE_SCRIPT, SHAPE_SCRIPT_BODY);
      } catch (e) {
        log('窗口外形: 写入脚本失败 ' + e);
        return;
      }
    }
    // 短时间内重复执行没有意义（每次都要起一个 PowerShell 进程）
    if (Date.now() - lastShapeCallTs < 400) return;
    lastShapeCallTs = Date.now();
    try {
      betterncm.app.exec('powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
        SHAPE_SCRIPT + '" -x ' + x + ' -y ' + y + ' -w ' + w + ' -h ' + h +
        ' -r ' + r + ' -s ' + (cfg.shadow === false ? '0' : '1') +
        ' -g ' + (cfg.gameTop === false ? '0' : '1'));
      log('窗口外形: 圆角=' + r + 'px 阴影=' + (cfg.shadow === false ? '关' : '开') +
        ' rect=' + x + ',' + y + ',' + w + ',' + h);
    } catch (e) {
      log('窗口外形: 执行失败 ' + e);
    }
  }

  function windowSize() {
    var card = clamp(cfg.width || DEFAULTS.width, 260, 720);
    return { width: card, height: Math.round(card * 0.35) };
  }

  function defaultPosition(size) {
    var sw = (window.screen && screen.availWidth) || 1280;
    var sh = (window.screen && screen.availHeight) || 720;
    return {
      x: Math.max(16, sw - size.width - 40),
      y: Math.max(16, sh - size.height - 40),
    };
  }

  function openWindow() {
    if (!window.channel || typeof channel.call !== 'function') {
      log('窗口: 当前环境不支持 winhelper.launchWindow');
      return;
    }
    if (windowAlive()) return;
    // 防止短时间内重复创建窗口
    if (Date.now() - lastLaunchAt < 6000) return;
    lastLaunchAt = Date.now();
    loggedGeometry = '';
    var size = windowSize();
    var saved = plugin.getConfig('pos', null) || cfg.pos;
    var pos = (saved && typeof saved.x === 'number' && typeof saved.y === 'number')
      ? saved : defaultPosition(size);
    // winhelper 的窗口尺寸 / 坐标使用物理像素，页面里的坐标是逻辑像素
    var dpr = window.devicePixelRatio || 1;
    var opts = {
      x: Math.round(pos.x * dpr),
      y: Math.round(pos.y * dpr),
      width: Math.round(size.width * dpr),
      height: Math.round(size.height * dpr),
      visible: true,
      resizable: false,
      taskbarButton: false,
      spec_window: false,
      // corner_size 用逻辑像素，与悬浮窗里的 CSS 圆角保持一致，避免出现两层圆角
      corner_size: Math.round(clamp(cfg.radius == null ? DEFAULTS.radius : cfg.radius, 0, 40)),
    };
    writeJSON(K_BEAT, { ts: Date.now(), x: opts.x, y: opts.y, pending: true });
    try {
      channel.call('winhelper.launchWindow', function (ok) {
        log('窗口: launchWindow -> ' + ok);
        shapeSoon(1300);
      }, [PAGE, opts, opts]);
    } catch (err) {
      log('窗口: 打开异常 ' + err);
    }
  }

  function closeWindow() {
    writeJSON(K_CMD, { seq: ++lastCmdSeq, action: 'close', ts: Date.now() });
    writeJSON(K_BEAT, { ts: 0 });
  }

  function reloadWindow() {
    closeWindow();
    setTimeout(function () {
      userClosed = false;
      openWindow();
    }, 900);
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

  function pollCommand() {
    var cmd = readJSON(K_CMD, null);
    if (!cmd || !cmd.seq || cmd.seq === lastCmdSeq) return;
    lastCmdSeq = cmd.seq;
    if (cmd.action === 'close') return;   // 关闭由悬浮窗自己执行
    runCommand(cmd.action);
  }

  // ---------------------------------------------------------------- 主循环

  function tick() {
    if (windowAlive()) {
      sawLiveWindow = true;
      rememberPosition();
    } else if (sawLiveWindow && !userClosed) {
      userClosed = true;
      log('窗口: 已被关闭');
    }
    if (!userClosed && cfg.enabled !== false && !windowAlive()) openWindow();
  }

  var started = false;

  function start() {
    if (started) return;
    started = true;
    cfg = readCfg();
    // 早期版本记录过无效的窗口坐标，升级后重置一次
    if (plugin.getConfig('posVersion', 0) < 2) {
      plugin.setConfig('pos', null);
      plugin.setConfig('posVersion', 2);
      cfg.pos = null;
    }
    publishTheme();
    // 忽略上一次运行遗留的命令 / 界面事件，避免启动时误触发
    var pendingCmd = readJSON(K_CMD, null);
    lastCmdSeq = pendingCmd && pendingCmd.seq ? pendingCmd.seq : 0;
    var pendingUi = readJSON(K_UI, null);
    lastUiEvent = pendingUi && pendingUi.ts ? pendingUi.ts : 0;
    writeJSON(K_BEAT, { ts: 0 });
    log('plugin: 启动，网易云版本 ' + (window.APP_CONF && APP_CONF.appver) +
      '，悬浮窗' + (cfg.enabled !== false ? '启用' : '停用'));
    setTimeout(function () {
      publishState();
      tick();
    }, 2500);
    setInterval(publishState, 500);
    setInterval(pollCommand, 400);
    setInterval(tick, 4000);
    setInterval(function () {
      var b = beat();
      if (b && b.api && b.ts && Date.now() - b.ts < 5000) {
        var signature = b.api.x + ',' + b.api.y + '/' + (b.css ? b.css.width : '-');
        if (b.anim) {
          signature += '/' + b.anim.titleX + (b.anim.titleFade ? 'F' : '') +
            ',' + b.anim.lyricX + (b.anim.lyricFade ? 'F' : '');
        }
        if (signature !== loggedGeometry) {
          loggedGeometry = signature;
          shapeSoon(1200);
          log('窗口: api=' + JSON.stringify(b.api) + ' css=' +
            (b.css ? b.css.width + 'x' + b.css.height : '?') + ' dpr=' + b.dpr +
            (b.geo ? ' geo=' + JSON.stringify(b.geo) : '') +
            (b.anim ? ' anim=' + JSON.stringify(b.anim) : ''));
        }
      }
    }, 1500);
    // 悬浮窗每次移动/改尺寸都会把最新位置写进 mfp.hide，这里据此关掉它周围的阴影窗口
    setInterval(function () {
      var req = readJSON(K_HIDE, null);
      if (req && req.ts && req.ts !== lastHideTs) {
        lastHideTs = req.ts;
        shapeRect = { x: req.x, y: req.y, w: req.width, h: req.height, r: req.r || 0 };
        shapeSoon(300);
      }
    }, 800);
    // 网易云有时会把阴影窗口重新摆出来，隔一会儿再补一刀
    setInterval(function () {
      if (shapeRect) shapeSoon(200);
    }, 15000);
    window.addEventListener('storage', function (ev) {
      if (ev.key === K_CMD) pollCommand();
      else if (ev.key === K_UI) logUiEvent();
    });
    setInterval(logUiEvent, 700);
  }

  function logUiEvent() {
    var ui = readJSON(K_UI, null);
    if (ui && ui.ts && ui.ts !== lastUiEvent) {
      lastUiEvent = ui.ts;
      log('悬浮窗操作: ' + ui.act);
      shapeSoon(900);
    }
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

    function range(key, min, max, step, onChange) {
      var wrap = document.createElement('span');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
      var input = document.createElement('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = cfg[key] !== undefined ? cfg[key] : DEFAULTS[key];
      input.style.width = '190px';
      var out = document.createElement('span');
      out.style.cssText = 'width:66px;text-align:right;opacity:.75;font-variant-numeric:tabular-nums';
      out.textContent = input.value;
      var timer = 0;
      var apply = function () {
        clearTimeout(timer);
        timer = 0;
        out.textContent = input.value;
        var patch = {};
        patch[key] = parseFloat(input.value);
        saveCfg(patch);
        if (onChange) onChange(patch[key]);
      };
      // 拖动过程中合并更新，避免窗口尺寸被连续重设导致闪动
      input.addEventListener('input', function () {
        out.textContent = input.value;
        clearTimeout(timer);
        timer = setTimeout(apply, 260);
      });
      input.addEventListener('change', apply);
      wrap.appendChild(input);
      wrap.appendChild(out);
      return wrap;
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
      if (value) {
        userClosed = false;
        openWindow();
      } else {
        userClosed = true;
        closeWindow();
      }
    }));

    var colorBox = document.createElement('span');
    colorBox.style.cssText = 'display:flex;align-items:center;gap:10px;';
    ['album', 'custom'].forEach(function (mode) {
      var label = document.createElement('label');
      label.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;';
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'mfp-bg-mode';
      radio.checked = (cfg.bgMode || DEFAULTS.bgMode) === mode;
      radio.addEventListener('change', function () {
        if (radio.checked) saveCfg({ bgMode: mode });
      });
      label.appendChild(radio);
      label.appendChild(document.createTextNode(mode === 'album' ? '专辑主要颜色' : '自定义颜色'));
      colorBox.appendChild(label);
    });
    var customColor = document.createElement('input');
    customColor.type = 'color';
    customColor.value = cfg.customColor || DEFAULTS.customColor;
    customColor.title = '自定义背景颜色';
    customColor.style.cssText = 'width:38px;height:24px;border:0;background:transparent;cursor:pointer;';
    customColor.addEventListener('change', function () {
      saveCfg({ customColor: customColor.value });
    });
    colorBox.appendChild(customColor);
    row('背景颜色', colorBox);
    row('白天模式（浅色背景）', checkbox('light'));
    row('沉浸模式（隐藏播放按钮）', checkbox('zen'));

    row('播放器宽度', range('width', 260, 720, 4));
    row('圆角半径', range('radius', 0, 32, 1));
    row('歌词字号', range('fontSize', 10, 20, 0.5));
    row('不透明度', range('opacity', 0.4, 1, 0.05));
    row('显示歌词翻译', checkbox('translation'));
    row('显示播放时间', checkbox('showTime'));
    row('窗口置顶', checkbox('alwaysOnTop'));
    row('全屏游戏上方显示', checkbox('gameTop'));
    row('显示阴影', checkbox('shadow', function () {
      shapeSoon(150);
    }));

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:2px;';
    actions.appendChild(button('打开悬浮窗', function () {
      userClosed = false;
      if (windowAlive()) {
        log('窗口: 已经在运行');
      } else {
        openWindow();
      }
    }));
    actions.appendChild(button('关闭悬浮窗', function () {
      userClosed = true;
      closeWindow();
    }));
    actions.appendChild(button('重新加载悬浮窗', reloadWindow));
    actions.appendChild(button('重置窗口位置', function () {
      plugin.setConfig('pos', null);
      cfg.pos = null;
      reloadWindow();
    }));
    box.appendChild(actions);

    var tip = document.createElement('div');
    tip.style.cssText = 'opacity:.6;font-size:12px;line-height:1.6;';
    tip.textContent = '设置即时生效；悬浮窗可用鼠标拖动到任意位置，位置会被记住。' +
      '歌词显示依赖 liblyric 或 LibEAPIRequest 插件。' +
      '「全屏游戏上方显示」只对窗口化 / 无边框 / 开启全屏优化的游戏有效，' +
      '独占全屏的游戏只有系统级覆盖层（如 Xbox Game Bar）能盖住。';
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
    publishTheme();
    return buildConfig();
  });
})();
