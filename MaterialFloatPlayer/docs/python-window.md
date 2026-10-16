# Python 悬浮窗：为什么、怎么接的

## 问题

插件拿到的窗口是网易云（`cloudmusic.exe`）创建的 `OrpheusBrowserHost`，我们只能从外面：

* `SetWindowRgn` 改窗口区域 —— 二值的，圆角边缘只能是硬台阶（放大能看到锯齿）；
* `SetWindowPos` 挪位置 —— 尺寸和位置还得按 `devicePixelRatio` 换算再反解缩放比；
* 去裁网易云画在四周的四段 `OrpheusShadow` 窗口 —— 才能让阴影贴着圆角走。

想做**逐像素 alpha**（真抗锯齿圆角 + 真模糊阴影）需要 `UpdateLayeredWindow`，而这个 API
必须由拥有窗口的进程调用。给别人的窗口加 `WS_EX_LAYERED` + `SetLayeredWindowAttributes`
只有"整体 alpha"和"色键"两种玩法，色键处理不了边缘的半透明像素，等于换汤不换药。
Win11 的 `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE)` 倒是 DWM 自己做的抗锯齿
裁剪，但半径固定 8px，对不上设置里 0–32 的滑块。

## 接法

把"渲染"和"数据/控制"拆开：

* **插件（云音乐进程内）**：读状态（`#main-player` + `getPlayingSong`）、拿歌词（liblyric /
  LibEAPIRequest）、执行命令（点网易云自己的播放栏按钮）。这些都是插件独有的能力。
* **mfp_py（独立进程）**：自建半透明分层窗口，负责所有绘制、动画、取色、拖拽、位置记忆，
  以及自己的设置窗口。
* **通道**：`C:/betterncm/mfp-bridge.json` 系列文件（见 README 里的表）。用文件而不是端口，
  因为插件的渲染进程碰文件最省事，不需要权限，也不用担心端口占用。

插件的 `tick()`（4 秒一次）用 `.beat` 的心跳判断 Python 还在不在，不在就 `betterncm.app.exec`
重新拉起；`.cmd` 里的命令按 `seq` 去重，启动时会先读一遍当前值，避免执行上一次运行遗留的命令。

2.1 起**不再保留网易云内置窗口**：既然渲染搬出去了，圆角 / 阴影 / DPI 那套外部手段
（窗口区域裁剪、四段阴影裁剪、PowerShell 脚本、缩放比校准）连同注入到页面里的
`window.js` 一起删掉了，插件只剩状态、歌词、控制、守护和设置页。Python 起不来时
桌面会没有悬浮窗，日志里会说明原因。

## 实测记录（网易云 2.10.13 + BetterNCM，2026-10-16）

在自己机器上跑通了一次完整链路，几个必须知道的点都是实测出来的：

* **`betterncm.fs.*` 是异步的**（内部是 `fetch` 打到本地 API）：
  `readFileText` / `exists` 返回的是 **Promise**，当成同步值用会静默拿到 `null`。
  第一版就是这么挂的 —— 写文件正常（fire and forget），读心跳永远读不到，
  于是插件以为 Python 没起来，每 8 秒重启一次它。现在插件里所有桥接读取都走 `.then`，
  并且在读失败时打一条日志（`桥接: 读 ... 失败`），不再静默。
* **`betterncm.app.exec` 的原生实现不好猜怎么切分命令行**：直接传
  `"C:\...\pythonw.exe" "C:\...\mfp.py" --bridge "..."` 在第一次启动时没起来。
  现在改成固定写一个 `C:\betterncm\MaterialFloatPlayer-python.cmd` 外壳，
  命令行里只有一个被引号包住的 `.cmd` 路径，其余全在文件里；出问题可以直接双击它复现。
  写文件同样是异步的，所以要先等写完再 exec。
* **`.venv\Scripts\pythonw.exe` 是启动器**，会再拉起真正的解释器：任务管理器里是两个
  pythonw 进程（父进程 5MB / 子进程 170MB），不是两个悬浮窗。
* **冷启动要十几秒**（Qt + WebView 之类都不算，单是 PySide6 导入 + 建窗口）：心跳因此改成
  **在 `mfp.py` 里还没 import Qt 之前就先写一次**，插件看到心跳就不会重复拉起；
  15 秒的超时也因此放宽到 25 秒，并且只要 Python 之后起来了，插件会把内置窗口关掉切回去。
* **单实例**：内核命名互斥体（`Local\MaterialFloatPlayerPy`）。普通启动时发现已有实例就退出；
  插件拉起来的实例会写一个 `quit.request` 请对方让位再接管 —— 否则用户在设置页打开开关时，
  桌面上会同时出现两张卡片。
* 封面链接（`p*.music.126.net`）Python 侧直接 `requests` 下载没问题，不需要 CORS。
* **进度会在一秒内回跳**：播放栏只给出整秒（`0:48`），插件把整秒 + 自己经过的时间一起送出去
  （`smoothPosition()`），Python 侧再做一次"播放中不回退"的钳制，
  两边加起来进度条和秒数就连续了。
* 歌词和配色一度完全不工作，原因是 Python 侧一次改动的补丁把 `_tick()` 从中间劈开了，
  轨道判断、歌词轮询、取色请求都变成了 `return` 之后的死代码。教训是：
  桥接这条路要有一个能单独跑的诊断工具（`floating window/tools/probe_bridge.py --app`），
  别只靠肉眼看窗口有没有出来。

## 还没验证的部分

* Python 没装好时的表现：目前只做过"把启动脚本路径藏起来"这类静态判断，
  真正的失败路径是"起不来 → 日志里写明原因（含可以手动跑的外壳脚本路径）"。
* 多显示器 / 缩放变化时切换位置：Python 悬浮窗自己会夹回可见区域，但没有跨屏搬动的优化。
