# Phone On Web 增强版

> 用电脑上的浏览器直接操作安卓手机：投屏、桌面版网页、剪贴板互通、下载自动回传。
> 不需要 root，不需要在手机上装任何 App（中文输入可选装 ADBKeyboard）。

这是一个 Chrome / Edge 扩展（Manifest V3）。它通过 **WebUSB + ADB** 直连手机，内置投屏用 scrcpy，
再叠一层扩展自己的界面：画面上一排操作栏、画面下一行状态、侧栏两个按钮。

```
┌───────────────────────────────────────────────────────┐
│ 在此输入，直接进手机  复制 粘贴 ← → ⟳ [网址] 打开 …    │  ← 操作栏
├───────────────────────────────────────────────────────┤
│ ◯ 网页浏览 │                                          │
│ ⚙ 设置     │           手机画面（实时镜像）             │
│            │                                          │
│            ├──────────────────────────────────────────┤
│            │ 镜像模式 · 手机上操作，这里同步显示        │  ← 状态行
└───────────────────────────────────────────────────────┘
```

---

## 项目简介

原版 [Browserlify](http://browserlify.com) 的扩展只做「投屏 + 用手机浏览器上网」。本项目在它的基础上
补齐了日常真正会用到的几件事，新增界面全部**声明在 `index.html` 里、只做停靠不重造**：

- **镜像即用**：电脑上看到的就是手机屏幕，鼠标点击、滚轮、拖动直接作用于手机。
- **两种模式**：镜像模式（看手机本身）与浏览器模式（手机跑 Edge/Chrome，电脑当显示器）。
- **输入统一**：英文/数字走镜像通道，中文走 CDP 或 ADBKeyboard 广播，两套通道自动选。
- **界面同源**：操作栏 / 状态行 / 侧栏两个按钮都写在 `index.html`，脚本只把它们停靠到原版
  布局里对应的位置（画面列、画布下方、侧栏那一列），外观沿用原版侧栏按钮，不另造一套视觉。

---

## 主要功能

| 分类 | 功能 |
|---|---|
| 投屏 | 内置 scrcpy 镜像（自动适配分辨率）；Android 16+ 自动切「兼容投屏」（截屏轮询，约 2–3 帧/秒） |
| 操作 | 左键点击、拖动、滚轮滚动；**右键 = 返回**，**中键 = 回到桌面**（不会在手机上触发上下文菜单） |
| 浏览器模式 | 侧栏「网页浏览」一键进入：拉起手机 Edge / Chrome → 横屏 → 全屏，关闭时按相反顺序还原 |
| 网页控制 | 后退 / 前进 / 刷新 / 地址栏直达 / 桌面版 UA / 手机横竖屏 / 页面缩放 10%–200% |
| 文本输入 | 操作栏输入框：英文走镜像通道，中文走 CDP `Input.insertText` 或 ADBKeyboard 广播 |
| 输入法 | 光标进输入框自动切 ADBKeyboard，失焦立刻切回原输入法（可关） |
| 特殊键 | 退格 / 回车 / Tab / Esc / 方向键 / Delete，浏览器模式走 CDP，镜像模式走 scrcpy → 广播 → `input keyevent` |
| 剪贴板 | 手机复制 → 电脑（自动轮询）；电脑 → 手机（`Ctrl+V` 或「粘贴」）；`Ctrl+C` / `Ctrl+A` 作用于手机选区 |
| 下载回传 | 监听手机目录，**只回传本次连接之后新增的文件**，按大小上限与时间范围过滤 |
| 文件上行 | `Ctrl+V`（剪贴板是文件）或把文件拖进窗口 → 写入手机；默认 `/sdcard/Download`，文件管理器开着时写它当前目录，写完刷新媒体库 |
| 文件面板 | 进入浏览器模式时自动收起 File Manager（它真的会挡住画面）；不动用户的 Home Bar 开关 |
| 界面 | 屏幕上方操作栏、画面下方状态行、侧栏两个按钮，节点声明在 HTML 里，脚本只负责停靠 |
| 授权 | 电脑侧 ADB 密钥固定并持久化，**同一把密钥只需在手机上授权一次** |

---

## 环境要求

- 桌面端：Chrome / Edge 89+（需要 WebUSB 与 Manifest V3）
- 手机端：Android 8.0+，开启「开发者选项 → USB 调试」
- 数据线：支持数据传输（只能充电的线无法握手）
- 中文输入（可选）：手机上安装 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard)。
  **Android 16 必须用 v2.5-dev**，v2.4-dev 的广播接收器在 API 33+ 收不到消息。

---

## 安装

1. 下载本仓库，或解压 `PhoneOnWeb-1.1.1-mod.zip` 到任意目录（目录名随意：扩展 ID 由
   `manifest.json` 里的 `key` 固定，不再随路径变化）。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择上一步的目录。
4. 点工具栏图标，扩展会在新标签页打开主界面。

---

## 使用说明

### 一、第一次连接

1. 手机上打开「开发者选项 → USB 调试」，用数据线连接电脑。
2. 扩展里点 **Connected**，在弹出的设备列表里选中手机。
3. 手机弹出「允许 USB 调试吗？」→ 勾选 **始终允许** → 确定。

> 这一步只需要做一次。扩展的 RSA 密钥保存在 `chrome.storage.local` 的 `private-key`，
> 换目录、重启浏览器、重插数据线都会复用它。设置页「USB 授权」里能看到密钥编号，
> **编号不变就说明手机不会再问**。

小米 / 红米用户：若镜像里点不动、或按键无效，请到开发者选项打开「**USB 调试（安全设置）**」，
然后重启手机。

### 二、镜像模式

连上即用，画面上就是手机屏幕：

- 左键点击 = 点手机；按住拖动 = 滑动；滚轮 = 上下滚动。
- **右键 = 返回**，**中键 = 回到桌面**。这两个键只走扩展自己的手势，原版收不到：
  原版把 `pointerdown` 一律当触摸下发（右键 = 次要键、中键 = 第三键），右键在手机上
  会弹出上下文菜单，所以扩展在捕获阶段把非左键的 pointer / mouse 链整条掐掉。
- 键盘直接打字：英文/数字即时送入；中文需要浏览器模式（CDP）或 ADBKeyboard。
- 操作栏在画面上方，状态行在画面下方，高度固定，提示来去不会让画面跳动。

### 三、浏览器模式

点侧栏的地球图标进入。扩展会按固定顺序执行：

| 开启 | 关闭 |
|---|---|
| ① 收起 File Manager | ① `am force-stop` 关掉手机浏览器 |
| ② 拉起手机 Edge / Chrome | ② 退出全屏（还原 `policy_control`） |
| ③ 切横屏 | ③ 恢复手机默认旋转 |
| ④ 全屏（隐藏状态栏/导航栏） | ④ 归还临时借用的输入法 |

- 操作栏变为完整形态：后退 / 前进 / 刷新 / 地址栏 / 桌面版 UA / 横竖屏 / 缩放 / 正文 / 关闭。
- 手机上两个浏览器都开着时，可在设置里指定用哪一个。
- 连点两下等于「开 → 关」，第二次点击会排队，不会出现两步交错。

### 四、中文输入

镜像模式下往原生 App 里送中文，只有 ADBKeyboard 这一条路（Android 的 `input text` 只认 ASCII）：

1. 手机上装 ADBKeyboard（Android 16 用 v2.5-dev）。
2. 设置里保持「输入法自动切换」开启（默认开）。
3. 光标点进操作栏的「在此输入，直接进手机」→ 扩展把手机切到 ADBKeyboard；
   离开输入框 → 立刻切回你原来的输入法。

不用把它设成日常输入法，也不需要手动切换。状态行会实时显示当前通道是否可用。

### 五、快捷键

| 按键 | 行为 |
|---|---|
| `Ctrl+C` | 把手机上选中的文字复制到电脑 |
| `Ctrl+V` | 把电脑剪贴板粘贴进手机当前输入框 |
| `Ctrl+A` | 全选手机页面（或聚焦的输入框） |
| `Enter` / `Tab` / `Esc` / 方向键 / `Delete` / `Backspace` | 转发到手机（浏览器模式带 `text`，表单能正常提交） |

### 六、下载回传

默认监听 `/sdcard/Download`、`/sdcard/MiShare`、`/sdcard/Pictures`（含子目录）。
**只同步本次连接之后新增的文件**，连接前就存在的不动；断开后基线作废。
设置页的「立即扫描一次」可直接验证目录是否扫得到。

### 七、把文件送进手机

连着手机时，两条路都能把电脑上的文件写进手机：

- **拖进来**：从资源管理器把文件拖到扩展窗口的任意位置（画面、工具条都行）。
- **`Ctrl+V`**：先在资源管理器里复制文件，再在扩展窗口按 `Ctrl+V`。
  剪贴板里是文字时仍然是老行为——文字直接打进手机，不会误当成文件。

目标目录按这个顺序判定：

| 条件 | 目标 |
|---|---|
| 原版「File Manager」面板**开着**，且它打开过某个目录 | 那个目录（换一级就跟着换，`..` 也算） |
| 面板没开 / 兼容投屏下手机端根本没有文件管理器 | `/sdcard/Download` |

每个文件的执行顺序是**先写、再核对、最后刷媒体库**：

1. 先算一个不冲突的文件名（重名自动改成 `name-1.ext`、`name-2.ext`…，**不覆盖**已有文件）；
2. 用 adb 的 `sync:` 通道写入（和原版「上传」按钮同一套协议，二进制安全、不受命令行长度限制）；
3. `stat` 核对写入后的大小，对不上就算这个文件失败；
4. 整批写完之后再刷新一次媒体库（`content call … scan_volume`），老系统不支持则退回逐文件
   `MEDIA_SCANNER_SCAN_FILE` 广播。**先写完再扫**：扫早了会索引到写了一半的文件。

失败不会中断整批：单个文件出错只跳过它，最后在画面下方汇总。常见原因会翻译成人话：

| 手机侧返回 | 提示 |
|---|---|
| `Permission denied` / `Read-only file system` | 这个目录不可写（`Android/data` 等受保护目录要换别处） |
| `No space left` | 存储空间不足 |
| `No such file` | 目标目录不存在（可能在文件管理器里换过目录） |

暂不支持把整个文件夹拖进来，请拖其中的文件。

### 八、设置项

| 分组 | 项目 | 默认 |
|---|---|---|
| 监听文件 | 监听目录 / 下载同步 / 单文件上限 / 只看最近 / 扫描间隔 | 三个目录 / 开 / 20 MB / 2 天 / 4 秒 |
| 剪贴板 | 手机 ↔ 电脑 | 开 |
| 中文输入 | 输入法自动切换（聚焦启用 / 失焦切回） | 开 |
| 手机浏览器 | 自动 / Edge / Chrome | 自动 |
| 投屏 | 自动 / 总是兼容投屏 / 只用内置投屏 | 自动 |
| 浏览器模式 | 自动横屏 / 自动全屏 / 桌面版网页 | 全开 |
| 页面缩放 | 默认缩放 | 50% |
| USB 授权 | 电脑密钥编号 / 重置密钥 | — |

配置保存在 `chrome.storage.local` 的 `wvbCfg`，可随时「恢复默认」。

---

## 目录结构

```
PhoneOnWeb-1.1.1-mod/
├── manifest.json          # MV3 清单：权限、固定扩展 ID 的 key、图标
├── background.js          # 点图标 → 打开 index.html
├── index.html             # 主界面：原版挂载点 + 扩展的静态界面（操作栏/状态行/侧栏/设置）
├── README.md
├── icons/
│   └── icon_64.png
└── assets/
    ├── index.js           # 原版 Vue 应用（上游构建产物，仅注入少量兼容补丁）
    ├── index.css          # 原版样式
    ├── worker.0c2a0f21.js # 原版内嵌的 scrcpy-server
    ├── webview.js         # 扩展主逻辑：界面定位、浏览器模式、输入、剪贴板、下载
    ├── cdp-core.js        # 传输无关的 HTTP / WebSocket / CDP 客户端
    ├── compat.js          # Android 16+ 兼容投屏（screencap 轮询 + input 注入）
    ├── adbkey.js          # ADB 密钥持久化（固定公钥，只授权一次）
    ├── filepush.js        # 文件上行：Ctrl+V / 拖放 → adb sync 写入 + 媒体库刷新
    └── wvb.css            # 扩展界面的样式（操作栏 / 状态行 / 侧栏 / 设置弹窗）
```

---

## 工作原理

- **传输**：`navigator.usb` → ADB 握手（RSA 签名认证）→ 复用 `@yume-chan/adb` 的协议实现跑 shell、
  sync、reverse 等能力，全部在扩展页面里完成。
- **投屏**：把内嵌的 scrcpy-server 推到手机执行，视频流走 forward 端口，扩展侧解码到 `<canvas>`。
  Android 16 移除了 `SurfaceControl.createDisplay`，scrcpy 1.24 启动即崩，于是自动降级为
  `screencap -p` 轮询 + `input tap/swipe` 注入（`compat.js`）。
- **浏览器模式**：手机浏览器开着 `devtools_remote` 时，用 `localabstract:` 直连 CDP，
  于是能 `Input.insertText`、`Emulation.setPageScaleFactor`、`Page.reload` 等等。
- **按键**：浏览器模式走 CDP `Input.dispatchKeyEvent`；镜像模式按 scrcpy `injectKeyCode` →
  ADBKeyboard `ADB_INPUT_CODE` → `input keyevent` 依次兜底。
- **界面**：原版是 Vue 应用。扩展的三块界面都写在 `index.html` 里（静态节点，不临时拼 HTML），
  脚本只把它们搬进原版布局：操作栏 `insertBefore` 到画面那一列的开头，状态行
  `insertAdjacentElement("afterend")` 到画面块后面，两个按钮 `appendChild` 进侧栏按钮那一列。
  搬动是幂等的，已经在位就不再碰，所以不会每帧重排。

---

## 已知限制

1. **剪贴板跨应用不实时**：Android 10+ 只允许有输入焦点的应用读剪贴板，读取发生在手机浏览器页面里，
   手机停在别的 App 时读不到，切回浏览器后会立即补同步。
2. **中文输入依赖通道**：镜像模式必须装 ADBKeyboard（Android 16 必须 v2.5-dev）；
   浏览器模式走 CDP，任意 Unicode 都支持。
3. **`Input.insertText` 不产生 keydown**：依赖 keydown 的网页自定义快捷键收不到。
4. **兼容投屏帧率低**：约 2–3 帧/秒，够看网页、点链接，不适合看视频。
5. **桌面宽度受手机屏幕限制**：镜像显示的是手机屏幕本身，模拟更宽的视口会截出重复画面。
6. **仅 Chromium 内核手机浏览器**：需要 `devtools_remote` 端口；不开放调试端口的国产浏览器只能投屏。
7. **不能替代系统代理**：只作用于扩展内的浏览体验。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 点了 Connected 没有设备框 | 数据线是否支持数据传输；手机 USB 调试是否开启；换 USB 口试试 |
| 刷新页面后连不上 | 先点 Disconnect 再点 Connected（扩展已在 `pagehide` 主动释放 USB 句柄） |
| 手机上每次都问「允许 USB 调试」 | 设置 → USB 授权，看密钥编号是否每次都变；编号变了说明存储被清（换了浏览器 profile / 扩展 ID） |
| 镜像里退格删不掉字 | 1.3.1 起已修：镜像模式按键走 scrcpy → 广播 → `input keyevent`；小米还需打开「USB 调试（安全设置）」 |
| 中文打字没反应 | 状态行会写原因：没装键盘 / 版本不兼容 / 没有输入框聚焦 / 广播被系统拦 |
| 画面不跟手 | 设置里调大扫描间隔；确认没有开多个扩展标签页（第二个会提示设备被占用） |
| Android 16 完全黑屏 | 已自动切兼容投屏；若没切，设置 → 投屏方式 → 总是用兼容投屏 |
| 进了浏览器模式却是另一个浏览器 | 手机上两个浏览器都开着时，设置里指定一个 |

---

## 开发与调试

```bat
:: 用独立 profile 加载扩展，并开调试端口
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --user-data-dir="%TEMP%\wvb-debug" ^
  --remote-debugging-port=9333 ^
  --load-extension="D:\path\PhoneOnWeb-1.1.1-mod"
```

扩展页控制台执行 `localStorage.wvbDebug = "1"; location.reload();` 可打开诊断日志
（`probe()` 会把关键步骤写到控制台）。诊断模式下同时暴露 `window.__wvb`
（`state / shell / pollDownloads / sendText …`）与 `window.__wvbKey`（密钥读写）。

界面相关的两个不变量，改动时请保持：

1. 界面节点只在 `index.html` 里声明，脚本**不 `createElement`、不拼 `innerHTML`**，搬动靠
   `positionMenu()` / `dockStatus()` / `injectSidebarButtons()` 三个幂等函数；
2. 侧栏按钮必须在原生按钮渲染出来的**同一帧**到位：靠 `MutationObserver`（绘制前回调）+ CSS
   `aside > div:has(> button:not([data-wvb-btn])){visibility:hidden}` 兜住分批渲染，否则会看到
   "5 个先出来、2 个后补上"。

---

## 版本记录

- `1.5.1` — 修文件上行报错 `Failed to execute 'pipeTo' on 'ReadableStream': parameter 1 is not of
  type 'WritableStream'`：原版 adb 客户端的 `sync.write()` 返回的是 bundle 内自带的
  WritableStream polyfill（不是原生实现），原生 `ReadableStream.pipeTo()` 品牌检查不认；改为
  `getWriter()` 后逐块写入并 `close()`。顺带删掉自己那层 64KB 分块（`sync.write()` 内部已切），
  `dispose()` 改为 await，避免未处理的 rejection。
- `1.5.0` — 新增文件上行：`Ctrl+V`（剪贴板是文件）与拖入窗口时，把文件写进手机。目标目录按
  「文件管理器开着就用它当前目录，否则 `/sdcard/Download`」判定；写入走 adb `sync:` 通道（新增
  `assets/filepush.js`），重名自动改名不覆盖，写完 `stat` 核对大小，整批结束后刷新一次媒体库
  （`scan_volume`，老系统退回逐文件广播）。`Ctrl+V` 不再无条件 `preventDefault`，改为先让 `paste`
  事件决定是文件还是文字，避免文件被当成文字粘贴。
- `1.4.2` — 修中键/右键手势：原版 `pointerdown` 不区分按键，右键被当成"次要键触摸"下发，
  手机上会弹上下文菜单（中键则是一记第三键触摸）。改为在文档捕获阶段掐掉非左键的
  `pointerdown/up/move` 与 `mouseup/auxclick/click/contextmenu`，原版桥一个都收不到；
  HOME 增加 `am start -a MAIN -c HOME` 通道（不依赖输入注入，MIUI 上 `input keyevent` 会被
  静默丢弃），并让 BACK/HOME 不再走 ADBKeyboard 的 `InputConnection`（系统键到不了 Activity）。
- `1.4.1` — 撤销 1.4.0 的界面重构，界面恢复为"静态节点 + 停靠进原版布局"（操作栏进画面列、
  状态行接画面块之后、两个按钮并入侧栏），保留鼠标手势与其中文说明。
- `1.4.0` — 界面层重构：操作栏 / 状态行 / 侧栏按钮改为纯静态节点 + 几何定位，删除 `MutationObserver`
  与节点搬移（原版界面 0 次 DOM 变更，不再闪动）；新增鼠标手势（右键返回、中键回桌面）；
  统一注释、样式变量与模块边界。
- `1.3.1` — 输入法改为聚焦驱动（进输入框即切 ADBKeyboard，失焦切回）；修镜像模式退格/回车失效（补
  scrcpy → 广播 → `input keyevent` 三通道）；CDP 回车补 `text`。
- `1.3.0` — 移除「进入浏览器模式自动关 Home Bar」；ADBKeyboard 兼容补强（版本/SDK 检测、临时切换、
  三级广播兜底）；修「每次都要重新授权」（固定扩展 ID + 密钥预置）。
- `1.2.9` — 状态行移到画面下方并固定高度；操作栏紧凑化；下载/剪贴板轮询加退避。
- `1.2.8` — 同时支持手机 Edge 与 Chrome；下载改为只回传本次连接新增的文件。

---

## 致谢与声明

- 投屏基于 [scrcpy](https://github.com/Genymobile/scrcpy)（Apache-2.0），ADB 协议实现基于
  [@yume-chan/adb](https://github.com/yume-chan/ya-webadb)（MIT），中文输入依赖
  [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard)。
- 原版界面与 `assets/index.js`、`index.css` 来自 Browserlify 的构建产物，版权归原作者所有；
  本仓库只做本地增强与兼容性修补，仅供个人学习与自用，请勿用于商业分发。
- 打开「USB 调试（安全设置）」等于把注入输入、改系统设置的能力交给这台电脑，排查完建议关闭。
