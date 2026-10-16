# MaterialFloatPlayer

网易云音乐 BetterNCM 插件 + 独立悬浮播放器：[这样的一张 Material 3 卡片](../../floating%20window)。

![preview](../../floating%20window/docs/preview.png)

## 它是怎么分工的

从 2.1 起，插件本身不再创建悬浮窗。界面交给一个独立的 Python 进程
（[floating window](../../floating%20window)，也就是 `mfp_py`），它自己创建半透明窗口：

* 圆角是**逐像素 alpha**，真的抗锯齿，不再靠 `SetWindowRgn` 裁区域；
* 阴影是卡片圆角轮廓的**模糊**，不是把网易云画的四段矩形阴影裁一圈；
* 尺寸和位置全用逻辑像素，不需要再按 `devicePixelRatio` 反解缩放比。

网易云的窗口是不透明的，`UpdateLayeredWindow`（逐像素 alpha）只能由窗口所属进程调用，
所以这件事在网易云进程里做不到 —— 只能在插件之外自己建窗口。插件这边保留的正是只有
它能做的事：

1. 读网易云自己的播放状态（歌曲、整秒进度、播放模式）；
2. 用 `liblyric` / `LibEAPIRequest` 拿歌词，含翻译和每句时长；
3. 把悬浮窗发来的命令交给网易云自己的播放栏按钮执行；
4. 看着心跳，负责把 Python 进程拉起来 / 重启 / 让它退出。

实测记录（异步文件 API、启动器外壳、冷启动、单实例互斥体）见
[docs/python-window.md](docs/python-window.md)。

## 安装

1. **装 Python 侧依赖**：在 `floating window` 目录里
   `python -m pip install -r requirements.txt`（或者用已经建好的 `.venv`）。
2. **装插件**：把 `MaterialFloatPlayer-<version>.plugin` 放进
   `C:\betterncm\plugins\`，重启网易云。BetterNCM 会把它解压到
   `C:\betterncm\plugins_runtime\MaterialFloatPlayer`。

第一次启动会自动确认解释器和启动脚本在不在（日志里会写
`桥接: 使用虚拟环境解释器 ...` / `桥接: 首次自动判断 -> ...`）：
`<floating window>/.venv/Scripts/pythonw.exe` 存在就用它，否则用 `PATH` 里的 `pythonw`。

## 设置项

插件设置页只留和 Python 进程相关的东西（外观全在悬浮窗自己的设置窗口里改）：

| 设置 | 说明 |
| --- | --- |
| 启用悬浮播放器 | 关掉后命令 Python 进程退出，不再自动拉起 |
| Python 解释器 | 留空用 `PATH` 里的 `pythonw`，也可以填绝对路径 |
| Python 启动脚本 | 留空用默认的 `floating window/mfp.py` |
| 桥接状态文件 | 留空用 `C:/betterncm/mfp-bridge.json` |

按钮：打开悬浮窗设置、重启悬浮窗、显示悬浮窗、隐藏悬浮窗。

悬浮窗自己的设置里有：背景颜色（专辑主要颜色 / 自定义）、白天模式、沉浸模式、
播放器宽度、圆角半径、歌词字号、不透明度、显示歌词翻译、显示播放时间、窗口置顶、
全屏游戏上方显示、显示阴影。曲目、进度、播放模式和歌词都直接读网易云，
不需要选"媒体来源"或"歌词来源"。

## 两个进程怎么说话

都以桥接状态文件路径为前缀，放在 `C:\betterncm\` 下：

```
插件 -> Python：mfp-bridge.json        播放状态（每次 publishState，约 500ms）
                mfp-bridge.json.lyric  歌词（变化时写一次，带翻译和每句时长）
                mfp-bridge.json.ctl    show / hide / reload / settings / quit
Python -> 插件：mfp-bridge.json.cmd     toggle / play / pause / next / prev / mode / close / quit
                mfp-bridge.json.beat    心跳，用来判断它是不是还活着
```

走文件而不是端口：插件的渲染进程碰文件最省事（它本来就在往 `C:/betterncm` 写日志），
不需要额外权限，也不用担心端口占用。注意 `betterncm.fs.*` 是**异步** API。

插件拉 Python 走的是自己写出来的 `C:\betterncm\MaterialFloatPlayer-python.cmd` 外壳：
命令行里只有一个被引号包住的 `.cmd` 路径，出问题可以直接双击它看报错。

## 依赖（可选）

歌词依赖下面任一插件，未安装时悬浮窗仍可正常显示，只是没有歌词：

- `liblyric`（推荐，支持翻译）
- `LibEAPIRequest`（插件会自己解析 LRC 与翻译）

## 源码结构

```
MaterialFloatPlayer/
  manifest.template.json  插件清单（2.x 不再注入页面代码）
  build.js                打包脚本：生成 dist/ 与 .plugin，并安装到 C:\betterncm\plugins
  src/main.js             全部插件逻辑：状态、歌词、控制、桥接、Python 守护、设置页
  docs/python-window.md   为什么这么做，以及实测踩过的坑
```

重新打包：

```powershell
cd MaterialFloatPlayer
node build.js              # 生成 dist/ 并安装到 C:\betterncm\plugins
node build.js --no-install # 只生成 dist/
```

装新版本时记得把旧的 `.plugin` 移走，否则 BetterNCM 会同时加载两份。

## 已知限制

- **独占全屏**的游戏由 DWM 直接把显示输出交给它，普通窗口物理上盖不上去；
  窗口化 / 无边框 / 开了全屏优化的游戏可以（「全屏游戏上方显示」用
  `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)`，不抢焦点）。
- **播放模式**转发的是网易云自己的 `.type` 按钮，具体几种模式由客户端决定
  （列表循环 / 单曲循环 / 随机 / 顺序 / 心动模式都会按真实状态显示图标）。
- 播放栏选择器基于网易云 2.10.x（当前 2.10.13），manifest 里限制为
  `>= 2.10.0 < 3.0.0`。
- 进度来自播放栏的整秒文字，插件会在这上面补上经过的小数时间，
  所以悬浮窗的进度条是连续的、不会每秒回跳；但拖动进度条的精度仍是整秒。
