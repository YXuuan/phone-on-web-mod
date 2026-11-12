// webview.js — 镜像模式浏览器（静态界面 + 几何定位）
// 显示沿用手机投屏；CDP 常驻一条轻量会话用于：键盘转发、剪贴板同步、下载同步。
// 依赖 window.__pe（PhoneClient，由 index.js 暴露）

import { WebSocket, Cdp, listTargets, wsPathOf } from "./cdp-core.js";
import { createCompatMirror } from "./compat.js";
import { createFilePusher } from "./filepush.js";
import { ensureAdbKey, adbKeyStatus, resetAdbKey } from "./adbkey.js";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

// ---------- 可配置项（存在 chrome.storage.local，设置页可改） ----------
const DEFAULT_CFG = {
  dirs: "/sdcard/Download\n/sdcard/MiShare\n/sdcard/Pictures",
  clipboard: true,
  downloads: true,
  maxMB: 20,
  days: 2,
  scanSec: 4,
  browser: "auto",
  landscape: true,
  immersive: true,
  desktop: true,
  zoom: 50,
  compat: "auto",
  imeAuto: true, // 输入框聚焦时把手机切到 ADBKeyboard，失焦切回
};

const state = {
  open: false,
  target: false, // 用户想要的状态（开关串行排队时用它切换）
  busy: false,
  lastUrl: "",
  landscape: false,
  desktop: true,
  zoom: 0.5,
  fmWatch: 0,
  watchTimer: 0,
  clipTimer: 0,
  dlTimer: 0,
  lastUA: "",
  desktopApplied: new Set(),
  seen: new Set(),
  service: null,
  live: null,
  livePending: null,
  clipTick: 0,
  clipLast: "",
  clipErr: "",
  clipPause: "",
  clipSkip: 0,
  dlSeen: new Map(),
  dlKey: "",
  dlSince: 0,
  dlBusy: false,
  dlSkip: 0,
  dlFail: 0,
  dlRounds: 0,
  dlPending: new Map(),
  dlSeeded: false,
  bg: false,
  cfg: { ...DEFAULT_CFG },
  svcAt: 0,
  pullingPath: "",
  busyAt: 0,
  rotPrev: null,
  immersivePrev: null,
  imePrev: null,
  compatSdk: 0,
  compatBusy: false,
  browserPkg: "", // 本次实际使用的手机浏览器包名（全屏策略 / 关闭时用）
  browserPref: "", // 上一次应用过的偏好，用来判断设置是否变了
  fmPath: "", // 文件管理器最近打开的目录（拖入/粘贴文件时用作目标）
};

// ---------- 诊断（发布版默认关闭；需要时在控制台执行 localStorage.wvbDebug="1" 后刷新）----------
const DEBUG = (() => {
  try {
    return localStorage.getItem("wvbDebug") === "1";
  } catch (e) {
    return false;
  }
})();

function probe(msg) {
  if (!DEBUG) return;
  try {
    fetch("http://127.0.0.1:8799/log?m=" + encodeURIComponent(String(msg)), { mode: "no-cors" }).catch(function () {});
  } catch (e) {}
}
window.addEventListener("unhandledrejection", (e) => probe("JS_REJECT " + String((e.reason && e.reason.message) || e.reason)));
window.addEventListener("error", (e) => probe("JS_ERROR " + (e && e.message)));
probe("panel-init debug=" + DEBUG);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byId = (id) => document.getElementById(id);

// ---------- 手机侧命令 ----------
async function shell(cmd) {
  const pe = window.__pe;
  if (!pe || !pe.device) throw new Error("手机未连接");
  try {
    return String(await pe.device.createSocketAndWait("shell:" + cmd));
  } catch (e1) {
    return String(await pe.device.subprocess.spawnAndWaitLegacy(["sh", "-c", cmd]));
  }
}

async function adbDuplex(service) {
  const pe = window.__pe;
  if (!pe || !pe.device) throw new Error("手机未连接");
  const sock = await pe.device.createSocket(service);
  const reader = sock.readable.getReader();
  const writer = sock.writable.getWriter();
  let done = false;
  return {
    async read() {
      if (done) return new Uint8Array(0);
      const { value, done: d } = await reader.read();
      if (d) {
        done = true;
        return new Uint8Array(0);
      }
      return value || new Uint8Array(0);
    },
    async write(bytes) {
      await writer.write(bytes);
    },
    close() {
      done = true;
      try {
        reader.cancel();
      } catch {}
      try {
        writer.close();
      } catch {}
      try {
        sock.close && sock.close();
      } catch {}
    },
  };
}

async function scanDevtools() {
  try {
    const text = await shell("cat /proc/net/unix");
    const names = new Set();
    for (const m of text.matchAll(/[A-Za-z0-9_.]*devtools_remote[A-Za-z0-9_]*/g)) names.add(m[0]);
    return [...names];
  } catch (e) {
    probe("scan fail " + (e && e.message));
    return [];
  }
}

// 手机浏览器：Edge 与 Chrome 并列支持（都是 Chromium，能连 CDP）
const EDGE_PKGS = ["com.microsoft.emmx", "com.microsoft.emmx.beta", "com.microsoft.emmx.canary", "com.microsoft.emmx.dev"];
const CHROME_PKGS = ["com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary"];
const BROWSER_PKGS = [...EDGE_PKGS, ...CHROME_PKGS];
const PRIMARY_PKGS = ["com.microsoft.emmx", "com.android.chrome"];

// 按设置排优先级：auto 就是 Edge→Chrome，指定了就把它排前面
function browserCandidates() {
  const pref = state.cfg.browser || "auto";
  if (pref === "chrome") return [...CHROME_PKGS, ...EDGE_PKGS];
  return [...BROWSER_PKGS];
}

// 谁在跑：先看两个主包，再看 beta/dev 通道
async function detectBrowserPkg(pkgs) {
  // 按调用方给的优先级查（已按设置排好），主包兜底
  const order = [...(pkgs && pkgs.length ? pkgs : BROWSER_PKGS), ...PRIMARY_PKGS];
  const seen = new Set();
  for (const pkg of order) {
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    try {
      const out = String(await shell(`pidof ${pkg}`)).trim();
      if (/^\d+/.test(out)) return pkg;
    } catch (e) {}
  }
  return "";
}

// 只找手机上"已经存在"的调试端口：镜像模式的后台轮询走这里，
// 绝不去拉起手机浏览器（否则一进扩展手机就自己弹出浏览器）。
async function findService() {
  if (state.service) return state.service;
  if (Date.now() - state.svcAt < 2500) return null; // 刚扫过，别反复扫
  state.svcAt = Date.now();
  const names = await scanDevtools();
  if (!names.length) return null;
  const pick = names.find((n) => n === "chrome_devtools_remote") || names.find((n) => /devtools_remote/.test(n)) || names[0];
  state.service = "localabstract:" + pick;
  probe("service " + names[0]);
  return state.service;
}

// 只有进入浏览器模式才允许拉起手机浏览器
async function launchService() {
  const found = await findService();
  if (found) {
    // 端口是现成的：看看是哪个浏览器在跑，全屏策略要用它的包名
    state.browserPkg = (await detectBrowserPkg(browserCandidates())) || state.browserPkg || "";
    probe("browser in use " + (state.browserPkg || "?"))
    return found;
  }
  state.svcAt = 0;
  let launched = "";
  for (const pkg of browserCandidates()) {
    const out = await shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`).catch((e) => "ERR " + (e && e.message));
    if (!/No activities found|aborted|ERR/i.test(out)) {
      launched = pkg;
      probe("launched " + pkg);
      break;
    }
  }
  let names = [];
  for (let i = 0; i < 10 && !names.length; i++) {
    await sleep(600);
    names = await scanDevtools();
  }
  probe("discovered: " + (names.length ? names.join(",") : "(none)"));
  if (!names.length) return null;
  state.service = "localabstract:" + names[0];
  state.browserPkg = launched || (await detectBrowserPkg(browserCandidates())) || "";
  probe("browser in use " + (state.browserPkg || "?"));
  return state.service;
}

// ---------- UA / 缩放 ----------
async function readUA(cdp) {
  try {
    const r = await cdp.send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
    state.lastUA = (r.result && r.result.value) || "";
  } catch (e) {}
  return state.lastUA;
}

const isDesktopUA = (ua) => /Windows NT|Macintosh|X11/.test(ua || "");

async function applyEmulation(cdp) {
  try {
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: state.desktop ? DESKTOP_UA : MOBILE_UA,
      acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
      platform: state.desktop ? "Win32" : "Linux armv8l",
    });
  } catch (e) {
    probe("ua fail " + (e && e.message));
  }
  try {
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: state.zoom });
  } catch (e) {
    probe("zoom fail " + (e && e.message));
  }
}

// ---------- 一次性会话：按需连一次就断 ----------
async function withVisibleTab(fn) {
  const service = await findService();
  if (!service) throw new Error("手机上还没打开浏览器（进入浏览器模式后会自动打开）");
  let targets;
  try {
    targets = await listTargets(() => adbDuplex(service));
  } catch (e) {
    state.service = null;
    state.svcAt = 0;
    const again = await findService();
    if (!again) throw e;
    targets = await listTargets(() => adbDuplex(again));
  }
  const pages = targets.filter((t) => t.type === "page" && /^https?:|^about:|^data:|^file:/.test(t.url || ""));
  if (!pages.length) throw new Error("没有可用的页面目标");
  pages.sort((a, b) => (b.url === state.lastUrl ? 1 : 0) - (a.url === state.lastUrl ? 1 : 0));

  for (const page of pages.slice(0, 8)) {
    let ws = null;
    try {
      ws = await WebSocket.connect(await adbDuplex(service), wsPathOf(page));
      const cdp = new Cdp(ws);
      const v = await cdp.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });
      if (v && v.result && v.result.value === "visible") {
        state.lastUrl = page.url || "";
        await readUA(cdp);
        await applyEmulation(cdp);
        probe("visible tab " + page.id + " " + (page.url || "").slice(0, 50));
        return await fn(cdp, page);
      }
    } catch (e) {
      probe("probe tab fail " + (e && e.message));
    } finally {
      try {
        ws && ws.close();
      } catch {}
    }
  }
  const page = pages[0];
  const ws = await WebSocket.connect(await adbDuplex(service), wsPathOf(page));
  try {
    state.lastUrl = page.url || "";
    const cdp = new Cdp(ws);
    await readUA(cdp);
    await applyEmulation(cdp);
    return await fn(cdp, page);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

// ---------- 常驻会话：键盘、剪贴板这类高频动作走它 ----------
function dropLive() {
  if (state.live) {
    try {
      state.live.ws && state.live.ws.close();
    } catch {}
    state.live = null;
  }
}

async function liveCdp() {
  if (state.live && state.live.cdp && state.live.ws && !state.live.ws.closed) return state.live.cdp;
  if (state.livePending) return state.livePending;
  state.livePending = openLive().finally(() => {
    state.livePending = null;
  });
  return state.livePending;
}

async function openLive() {
  const service = await findService();
  if (!service) throw new Error("手机上还没打开浏览器");
  const targets = await listTargets(() => adbDuplex(service));
  const pages = targets.filter((t) => t.type === "page" && /^https?:|^about:|^data:|^file:/.test(t.url || ""));
  for (const page of pages.slice(0, 8)) {
    let ws = null;
    try {
      ws = await WebSocket.connect(await adbDuplex(service), wsPathOf(page));
      const cdp = new Cdp(ws);
      const v = await cdp.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });
      if (!v || !v.result || v.result.value !== "visible") {
        ws.close();
        continue;
      }
      cdp.onClose(() => {
        if (state.live && state.live.ws === ws) state.live = null;
      });
      state.live = { cdp, ws, pageId: page.id, url: page.url || "" };
      state.lastUrl = page.url || "";
      // 剪贴板读权限：先按页面 origin 授权，不行再不指定 origin 授权
      const perms = ["clipboardReadWrite", "clipboardSanitizedWrite"];
      let origin = "";
      try {
        origin = new URL(page.url || "").origin;
      } catch (e) {}
      if (origin && origin !== "null") {
        await cdp.send("Browser.grantPermissions", { permissions: perms, origin }).catch(() => {});
      }
      await cdp.send("Browser.grantPermissions", { permissions: perms }).catch(() => {});
      // 让页面认为自己处于焦点（手机切到别的 App 时也能读剪贴板）
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      probe("live session " + page.id);
      return cdp;
    } catch (e) {
      try {
        ws && ws.close();
      } catch {}
    }
  }
  throw new Error("没有可见的网页");
}

// ---------- 文本注入：先判断是不是纯 ASCII ----------
// scrcpy 1.24 的文本注入走 KeyCharacterMap，只能映射 ASCII；
// 中文/emoji 只有 CDP 的 Input.insertText 或 ADBKeyboard 广播能送进去。
const isAscii = (s) => /^[\t\n\r\x20-\x7E]*$/.test(s);

// ---------- ADBKeyboard：镜像模式下中文/emoji 的唯一通道 ----------
// 三条硬约束（决定了这里的检测方式）：
//  ① 必须是「当前输入法」：那串广播最终走 InputConnection.commitText，
//     只装不切（甚至只 enable 不 set）都不会有输入连接，文字无处可去；
//  ② Android 16（API 36）上 v2.4-dev 收不到广播：它的接收器注册在
//     onCreateInputView 里且没带 RECEIVER_EXPORTED，shell（另一个 UID）
//     发的广播直接被拦掉；v2.5-dev 才把它挪到 onCreate + RECEIVER_EXPORTED；
//  ③ 参数只能走 base64：O/P 之后 am 不再可靠地传 UTF-8 文本。
const IME_ID = "com.android.adbkeyboard/.AdbIME";
const IME_PKG = "com.android.adbkeyboard";

// {installed,def,active,version,sdk,broken}
let imeInfo = null;
// 通道能力的指纹：变了才去刷新操作栏，避免每次探测都动 DOM
let imeSig = "";
// 借来的输入法：切走前用户用的那个（非空表示"是我们换的"，用完必须换回去）
let imeSwitchedFrom = "";
// 输入框是否正占着 ADBKeyboard：聚焦期间不自动还原，失焦才还
let imeHold = false;

// 一次 shell 往返拿全：装没装、默认输入法、真正在用的输入法、版本、SDK
async function probeIme() {
  let raw = "";
  try {
    raw = await shell(
      "echo @pkg; pm list packages " + IME_PKG +
      "; echo @def; settings get secure default_input_method" +
      "; echo @cur; dumpsys input_method | grep -m1 mCurMethodId" +
      "; echo @ver; dumpsys package " + IME_PKG + " | grep -m1 versionName" +
      "; echo @sdk; getprop ro.build.version.sdk"
    );
  } catch (e) {
    imeInfo = { installed: false, def: "", active: false, version: "", sdk: 0, broken: false };
    probe("ime probe fail " + (e && e.message));
    return imeInfo;
  }
  const seg = (tag, next) => {
    const i = raw.indexOf("@" + tag);
    if (i < 0) return "";
    const from = raw.indexOf("\n", i);
    if (from < 0) return "";
    const to = next ? raw.indexOf("@" + next, from) : -1;
    return raw.slice(from + 1, to < 0 ? raw.length : to).trim();
  };
  const isOurs = (s) => /com\.android\.adbkeyboard/i.test(s || "");
  const pkg = seg("pkg", "def");
  const def = seg("def", "cur");
  const cur = seg("cur", "ver");
  const version = seg("ver", "sdk").replace(/^versionName=/, "").trim();
  const sdk = parseInt(seg("sdk", ""), 10) || 0;
  const vnum = parseFloat((version.match(/\d+(\.\d+)?/) || [0])[0]) || 0;
  imeInfo = {
    installed: isOurs(pkg) || isOurs(version),
    def: def === "null" ? "" : def,
    // dumpsys 才是真正在用的那个；查不到时退回默认输入法
    active: isOurs(cur) || isOurs(def),
    version,
    sdk,
    // 2.4 及更早的版本在 API 36 上收不到广播
    broken: sdk >= 36 && vnum > 0 && vnum < 2.5,
  };
  probe(`ime installed=${imeInfo.installed} active=${imeInfo.active} ver=${version} sdk=${sdk} broken=${imeInfo.broken}`);
  // 通道能力变了（刚装/刚升级键盘、自动切换开关变了）：操作栏要立刻跟上
  const sig = `${imeInfo.installed}|${imeInfo.broken}|${imeInfo.active}|${state.cfg.imeAuto ? 1 : 0}`;
  if (sig !== imeSig) {
    imeSig = sig;
    try {
      syncChrome();
    } catch (e) {}
  }
  return imeInfo;
}

// 中文能不能送进手机：浏览器模式有 CDP（任意 Unicode），镜像模式靠 ADBKeyboard。
// 允许自动切换时，只要装了键盘就算可用（聚焦时就切过去，发送直接用）。
function zhInputReady() {
  if (state.open) return true;
  const i = imeInfo;
  if (!i || !i.installed || i.broken) return false;
  return i.active || !!state.cfg.imeAuto;
}

// 镜像模式下定时确认一次（用户可能在手机上换了输入法 / 升级了键盘）
let imeAt = 0;
let imeBusy = false;
async function refreshImeGate() {
  if (imeBusy || state.open || !deviceReady()) return;
  if (Date.now() - imeAt < 30000) return;
  imeAt = Date.now();
  imeBusy = true;
  try {
    await probeIme();
  } catch (e) {
    imeInfo = imeInfo || { installed: false, def: "", active: false, version: "", sdk: 0, broken: false };
  } finally {
    imeBusy = false;
    try {
      syncChrome();
    } catch (e) {}
  }
}

function b64utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function inputTextByShell(text) {
  await shell(`input text '${String(text).replace(/'/g, "'\\''")}'`);
}

// 按码点切块：单条广播别太长，emoji/代理对也不会被切断
function chunkText(text, max) {
  const out = [];
  let cur = "";
  for (const ch of String(text)) {
    if (cur && cur.length + ch.length > max) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// 有没有输入框在等输入：mServedInputConnection=null 时 commitText 无处可去
async function imeHasField() {
  try {
    const out = String(await shell("dumpsys input_method | grep -m1 mServedInputConnection")).trim();
    if (!out) return true; // ROM 不输出这一行：不拦，交给广播结果
    return !/mServedInputConnection\s*=\s*null/i.test(out);
  } catch (e) {
    return true;
  }
}

// 一条文本：B64 为主，CHARS（码点数组）与纯文本各兜一次
async function imeBroadcast(part) {
  try {
    const out = await shell(`am broadcast -a ADB_INPUT_B64 --es msg ${b64utf8(part)}`);
    if (/Broadcast completed/i.test(out)) return true;
  } catch (e) {
    probe("ime b64 fail " + (e && e.message));
  }
  try {
    const cps = [...part].map((c) => c.codePointAt(0)).join(",");
    const out = await shell(`am broadcast -a ADB_INPUT_CHARS --eia chars ${cps}`);
    if (/Broadcast completed/i.test(out)) return true;
  } catch (e) {
    probe("ime chars fail " + (e && e.message));
  }
  try {
    const quoted = String(part).replace(/'/g, "'\\''");
    const out = await shell(`am broadcast -a ADB_INPUT_TEXT --es msg '${quoted}'`);
    return /Broadcast completed/i.test(out);
  } catch (e) {
    probe("ime text fail " + (e && e.message));
    return false;
  }
}

// 切到 ADBKeyboard（它没有候选词，不适合当日常输入法，所以只借用一会儿）。
// 记住用户原来那个，只记一次：连续切几次不能把"原来的输入法"覆盖成 ADBKeyboard。
async function imeSwitch() {
  const info = imeInfo || (await probeIme());
  if (info.active) return true;
  try {
    await shell(`ime enable ${IME_ID}`);
    await shell(`ime set ${IME_ID}`);
  } catch (e) {
    probe("ime switch fail " + (e && e.message));
    return false;
  }
  const fresh = !imeSwitchedFrom;
  if (fresh) imeSwitchedFrom = info.def || "";
  await sleep(180);
  const now = await probeIme();
  if (!now.active) {
    if (fresh) imeSwitchedFrom = ""; // 没切成功，别留一个假的"原来那个"
    return false;
  }
  return true;
}

// 把借来的输入法还回去。输入框还占着（imeHold）时不还。
function restoreIme() {
  if (!imeSwitchedFrom || imeHold) return;
  const back = imeSwitchedFrom;
  imeSwitchedFrom = "";
  shell(`ime set ${back}`)
    .then(() => probe("ime restored " + back))
    .catch((e) => probe("ime restore fail " + (e && e.message)));
}

// 不在聚焦路径上（比如 Ctrl+V 直接粘贴、或组合结束直发）时，发完再择机还原
function scheduleImeRestore(ms) {
  if (imeHold || !imeSwitchedFrom) return;
  setTimeout(restoreIme, ms || 1500);
}

// 输入框拿到焦点：先把手机上的输入法顶上，用户打字时不用再等切换
async function imeOnFocus() {
  if (state.open || !deviceReady() || !state.cfg.imeAuto) return;
  const info = await probeIme();
  if (!info.installed || info.broken || info.active) return;
  imeHold = true; // 先占位：切换途中失焦也不会被提前还原
  const ok = await imeSwitch();
  probe("ime hold " + (ok ? "on" : "fail"));
  if (!ok) {
    imeHold = false;
    return;
  }
  // 切换的这 200ms 里用户可能已经点走了
  if (document.activeElement !== ui.kbd) {
    imeHold = false;
    restoreIme();
  }
}

// 输入框失焦：还回去
function imeOnBlur() {
  imeHold = false;
  restoreIme();
}

// 返回 {ok, why}：why 是给用户看的一句话，直接进状态行
async function sendTextViaIme(text) {
  const info = await probeIme();
  if (!info.installed) {
    return { ok: false, why: "手机上没装 ADBKeyboard：装 v2.5-dev 后才能把中文送进原生 App" };
  }
  if (info.broken) {
    return {
      ok: false,
      why: `ADBKeyboard ${info.version} 在 Android ${info.sdk} 上收不到广播：请换 v2.5-dev（A16 修复版）`,
    };
  }
  // 先确认有输入框在等输入（切换输入法会重建输入连接，提前判断更省事）
  if (!(await imeHasField())) {
    return { ok: false, why: "手机上还没有输入框获得焦点：先点一下要输入的框" };
  }
  if (!info.active) {
    if (!state.cfg.imeAuto && !imeHold) {
      return { ok: false, why: "中文需要 ADBKeyboard 作当前输入法：手机上切过去，或打开设置里的「输入法自动切换」" };
    }
    if (!(await imeSwitch())) {
      return { ok: false, why: "切换输入法失败：请在手机「设置 → 输入法」里启用 ADBKeyboard" };
    }
  }
  for (const part of chunkText(text, 200)) {
    if (!(await imeBroadcast(part))) {
      imeHold = false;
      restoreIme();
      return { ok: false, why: "广播没送达手机输入法（检查 ADBKeyboard 是否被系统停用）" };
    }
  }
  // 聚焦期间保持就位，连续输入不再来回切；其余路径发完就还
  scheduleImeRestore(1500);
  return { ok: true };
}

async function sendText(text) {
  if (!text) return false;
  // 1) 有可调试页面（手机浏览器 / 任意 Chromium 页面）：任意 Unicode 都能注入
  try {
    const cdp = await liveCdp();
    await cdp.send("Input.insertText", { text });
    say("已输入 " + text.length + " 字", "ok");
    return true;
  } catch (e) {
    dropLive();
    probe("insertText cdp fail " + (e && e.message));
  }
  // 2) 镜像模式：走 scrcpy 控制通道，只有 ASCII 能映射成按键
  if (isAscii(text)) {
    const c = window.__pe && window.__pe.client;
    if (c && typeof c.injectText === "function") {
      try {
        await c.injectText(text);
        say("已输入 " + text.length + " 字（镜像通道）", "ok");
        return true;
      } catch (e) {
        probe("injectText fail " + (e && e.message));
      }
    }
    // 3) 兼容投屏（没有 scrcpy 控制流）：shell input text，同样只支持 ASCII
    try {
      await inputTextByShell(text);
      say("已输入 " + text.length + " 字（shell 通道）", "ok");
      return true;
    } catch (e) {
      probe("input text fail " + (e && e.message));
    }
  }
  // 4) 中文：走 ADBKeyboard 广播（必要时临时切输入法）
  if (!isAscii(text)) {
    const r = await sendTextViaIme(text);
    if (r.ok) {
      say("已输入 " + text.length + " 字（ADB 输入法）", "ok");
      return true;
    }
    say(r.why, "err");
    return false;
  }
  say("输入失败：手机上还没有能接收输入的输入框（先在手机上点一下输入框）", "err");
  return false;
}

const KEYMAP = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Delete: { code: "Delete", vk: 46 },
};

// 对应的 Android KeyEvent 编号（镜像模式没有 CDP 时用）。
// Android 没有 ESC 键，按原版键盘桥的做法把 Escape 映射成"返回"。
const KEYCODE = {
  Enter: 66,
  Backspace: 67,
  Tab: 61,
  Escape: 4,
  ArrowLeft: 21,
  ArrowRight: 22,
  ArrowUp: 19,
  ArrowDown: 20,
  Delete: 112,
  Back: 4,
  Home: 3,
};

const sendKeyViaIme = async (code) => {
  try {
    const out = await shell(`am broadcast -a ADB_INPUT_CODE --ei code ${code}`);
    return /Broadcast completed/i.test(out);
  } catch (e) {
    probe("key ime fail " + (e && e.message));
    return false;
  }
};

// HOME 有一条不依赖输入注入的走法：把桌面的 MAIN/HOME Activity 直接拉到前台。
// MIUI 没开「USB 调试（安全设置）」时会静默丢弃 input keyevent，am start 不受影响。
async function homeByAm() {
  try {
    const out = String(await shell("am start -a android.intent.action.MAIN -c android.intent.category.HOME"));
    if (/Error|Exception|Permission Denial|not found/i.test(out)) {
      probe("home am fail " + out.trim().slice(0, 120));
      return false;
    }
    probe("home by am");
    return true;
  } catch (e) {
    probe("home am fail " + (e && e.message));
    return false;
  }
}

// 镜像模式下的按键通道：scrcpy 控制流 → ADBKeyboard（编辑键）→ am start（HOME）→ input keyevent
async function keyByPhone(key) {
  const code = KEYCODE[key];
  if (!code) return false;
  // 系统键（返回 / 主页）不能走 InputConnection：它只把按键交给当前输入框所在的窗口，
  // 到不了 Activity 的按键分发，广播出去也是白发，还会因为"Broadcast completed"
  // 让我们误以为成功、把后面真正生效的通道跳过去。所以这两键只走真按键。
  const sys = code === KEYCODE.Home || code === KEYCODE.Back;
  // ① scrcpy 控制流：等价于按了一下实体键，最快，也不需要额外权限
  const c = window.__pe && window.__pe.client;
  if (c && typeof c.injectKeyCode === "function") {
    try {
      await c.injectKeyCode({ action: 0, keyCode: code, metaState: 0, repeat: 0 });
      await c.injectKeyCode({ action: 1, keyCode: code, metaState: 0, repeat: 0 });
      return true;
    } catch (e) {
      probe("key inject fail " + (e && e.message));
    }
  }
  // ② 我们正占着 ADBKeyboard（输入框有焦点）：编辑键走它的 InputConnection。
  //    小米没开「USB 调试（安全设置）」时 input keyevent 会被静默丢弃，这条更可靠。
  if (!sys && imeHold && imeInfo && imeInfo.active && (await sendKeyViaIme(code))) return true;
  // ③ HOME：am start 拉起桌面，比 input keyevent 可靠（后者在 MIUI 上会被丢掉）
  if (code === KEYCODE.Home && (await homeByAm())) return true;
  // ④ input keyevent：任何调试授权都可用的通用兜底（无输出，成功与否都看不出来）
  try {
    await shell(`input keyevent ${code}`);
    return true;
  } catch (e) {
    probe("key shell fail " + (e && e.message));
  }
  // ⑤ 用户自己把 ADBKeyboard 设成当前输入法时，编辑键还能走广播
  if (!sys && imeInfo && imeInfo.active && (await sendKeyViaIme(code))) return true;
  return false;
}

// 手势 / 快捷按键用：失败给一句提示就够了，不必抛错
async function phoneKey(key) {
  const ok = await keyByPhone(key);
  if (!ok) say("按键没送出去：手机可能已断开", "err");
  return ok;
}

async function sendKey(key) {
  const k = KEYMAP[key];
  if (!k) return;
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  // 浏览器模式：手机前台就是这个页面，直接打到页面里最准（Enter 必须带 text，
  // 否则页面只收到"按下回车"而没有字符，表单不会提交）
  if (state.open) {
    try {
      const cdp = await liveCdp();
      await cdp.send("Input.dispatchKeyEvent", k.text ? { type: "keyDown", text: k.text, ...base } : { type: "rawKeyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return;
    } catch (e) {
      dropLive();
      probe("key cdp fail " + (e && e.message));
    }
  }
  // 镜像模式：按键要进手机当前前台 App。这里绝不能复用 CDP —— 手机上可能同时
  // 跑着一个后台浏览器，那样按键会被送进看不见的那个页面，前台输入的框毫无反应。
  if (await keyByPhone(key)) return;
  say("按键没送出去：检查手机是否已断开，小米还需打开「USB 调试（安全设置）」", "err");
}

// 手机上如果弹了软键盘，用 ESC 收起来（只在确实显示时发）
async function hidePhoneIme() {
  try {
    const out = String(await shell("dumpsys input_method | grep -m1 mInputShown"));
    if (!/mInputShown=true/.test(out)) return;
    await shell("input keyevent 111");
    probe("ime hidden");
  } catch (e) {}
}

// ---------- 手机侧状态：横竖屏、全屏、软键盘 ----------
async function setLandscape(on) {
  if (state.landscape === on) return;
  try {
    if (on) {
      if (state.rotPrev === null) {
        const acc = String(await shell("settings get system accelerometer_rotation")).trim();
        const rot = String(await shell("settings get system user_rotation")).trim();
        state.rotPrev = { acc, rot };
      }
      await shell("settings put system accelerometer_rotation 0");
      await shell("settings put system user_rotation 1");
    } else {
      // 无论有没有记录到原值都要恢复：横屏是我们改的，退出时必须还回去
      const prev = state.rotPrev;
      state.rotPrev = null;
      await restoreRotation(prev);
    }
    state.landscape = on;
    probe("landscape=" + on);
  } catch (e) {
    probe("rotate fail " + (e && e.message));
  }
}

// 恢复手机原本的旋转设置：没有记录时回到"跟随系统 + 竖屏"（多数机器的默认值）
async function restoreRotation(prev) {
  const acc = prev && prev.acc && prev.acc !== "null" ? prev.acc : "1";
  const rot = prev && prev.rot && prev.rot !== "null" ? prev.rot : "0";
  try {
    await shell("settings put system user_rotation " + rot);
  } catch (e) {}
  try {
    await shell("settings put system accelerometer_rotation " + acc);
  } catch (e) {}
  probe("rotation restored acc=" + acc + " rot=" + rot);
}

async function setImmersive(on) {
  try {
    if (on) {
      if (state.immersivePrev === null) {
        state.immersivePrev = String(await shell("settings get global policy_control")).trim();
      }
      // 全屏策略必须写实际在用的包名：Edge 与 Chrome 是两个包，写死任何一个另一个都不生效
      const pkg = state.browserPkg || PRIMARY_PKGS.join(":");
      await shell("settings put global policy_control immersive.full=" + pkg);
      probe("immersive target " + pkg);
    } else if (state.immersivePrev !== null) {
      const prev = state.immersivePrev;
      state.immersivePrev = null;
      if (!prev || prev === "null") await shell("settings delete global policy_control");
      else await shell("settings put global policy_control " + prev);
    }
    probe("immersive=" + on);
  } catch (e) {
    probe("immersive fail " + (e && e.message));
  }
}

// 让软键盘不要因为"有硬件键盘"而弹出来（输入法状态栏也就不会顶起页面）
async function setImeSuppress(on) {
  try {
    if (on) {
      if (state.imePrev === null) {
        const prev = String(await shell("settings get secure show_ime_with_hard_keyboard")).trim();
        state.imePrev = prev;
      }
      await shell("settings put secure show_ime_with_hard_keyboard 0");
    } else if (state.imePrev !== null) {
      const prev = state.imePrev;
      state.imePrev = null;
      if (!prev || prev === "null") await shell("settings delete secure show_ime_with_hard_keyboard");
      else await shell("settings put secure show_ime_with_hard_keyboard " + prev);
    }
    probe("ime suppress=" + on);
  } catch (e) {
    probe("ime suppress fail " + (e && e.message));
  }
}

// ---------- 画面区域：扩展界面的定位基准 ----------
// 只认内置投屏自己那块画布；兼容投屏的浮层画布要排除，否则会自己对齐自己
function mirrorCanvas() {
  return (
    [...document.querySelectorAll("canvas")].find(
      (c) => c.id !== "wvb-compat-canvas" && c.width > 80 && c.height > 80 && c.offsetParent !== null
    ) || null
  );
}

// 原版放画面的那一列（内置投屏还没建出画布时用它兜底）
function screenColumn(c) {
  for (const aside of document.querySelectorAll("aside")) {
    const p = aside.parentElement;
    if (!p) continue;
    const cols = [...p.children].filter((el) => el.tagName === "DIV" && el !== aside);
    const withCanvas = c ? cols.find((el) => el.contains(c)) : null;
    if (withCanvas) return withCanvas;
    if (cols.length) return cols[0];
  }
  return null;
}

// 画面的矩形：画布优先，其次它所在的那一列
function stageRect() {
  const c = mirrorCanvas();
  if (c) {
    const r = c.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 40) return r;
  }
  const col = screenColumn(c);
  if (col) {
    const r = col.getBoundingClientRect();
    if (r.width >= 40) return r;
  }
  return null;
}

// ---------- 扩展界面的停靠 ----------
// 三块界面都写在 index.html 里，这里只把它们搬到原版布局对应的位置：
//   操作栏   → 画面那一列的第一条子节点（把画面上沿往下顶一点，不遮住内容）
//   状态行   → 画面块的正下方（高度固定，只换文字）
//   两个按钮 → 原版侧栏按钮所在的那一列
// 搬动都是幂等的：已经在位就直接返回，不会每帧重排。

// 画面所在的那一列：aside 的兄弟 div，优先取包着画布的那个
function menuHost() {
  return screenColumn(mirrorCanvas());
}

function positionMenu() {
  const host = menuHost();
  if (!host) return false;
  if (ui.bar.parentNode !== host || host.firstElementChild !== ui.bar) {
    host.insertBefore(ui.bar, host.firstElementChild);
  }
  return true;
}

function undockMenu() {
  if (ui.bar.parentNode !== document.body) document.body.appendChild(ui.bar);
}

// 画面块：画面列里包含画布的那条子节点（画布可能被一层 wrapper 包着）
function stageBlock() {
  const c = mirrorCanvas();
  if (!c) return null;
  const host = menuHost();
  const blk = host && [...host.children].find((el) => el !== ui.bar && el.contains(c));
  return blk || c;
}

function dockStatus() {
  const after = stageBlock();
  if (!after || !after.parentNode) return false;
  if (ui.status.parentNode !== after.parentNode || ui.status.previousElementSibling !== after) {
    after.insertAdjacentElement("afterend", ui.status);
  }
  return true;
}

// 原版侧栏里装按钮的那一列
function sidebarHolder() {
  const native = [...document.querySelectorAll("aside button")].find(
    (b) => !b.hasAttribute("data-wvb-btn")
  );
  if (!native) return null;
  let el = native.parentElement;
  while (el && el.parentElement && el.parentElement.tagName !== "ASIDE" && el.tagName !== "ASIDE") {
    el = el.parentElement;
  }
  return el || native.parentElement;
}

// ---------- 原版「File Manager」：开没开、停在哪一级 ----------
// 按钮文字里带 "File Manager"，展开时类名会变成 bg-gray-300 text-gray-800
function sideButton(label) {
  return [...document.querySelectorAll("aside button")].find(
    (b) => !b.hasAttribute("data-wvb-btn") && (b.textContent || "").indexOf(label) >= 0
  );
}

function fmOpen() {
  const b = sideButton("File Manager");
  return !!b && /bg-gray-300|text-gray-800/.test(b.className || "");
}

// 文件管理器每换一次目录都会调用 sync 层的 openDir()。它是 `pe.getFileManager()`
// 每次新建的同一个小类的实例，所以只要改一次原型，组件里那个实例也跟着生效。
// 这样不用猜 DOM、也不用猜面包屑，直接拿到它真正打开的绝对路径。
let fmHooked = false;
function hookFileManager() {
  if (fmHooked) return true;
  const pe = window.__pe;
  if (!pe || typeof pe.getFileManager !== "function") return false;
  let fm = null;
  try {
    fm = pe.getFileManager(); // 没连 scrcpy 时返回 undefined
  } catch (e) {
    return false;
  }
  if (!fm) return false;
  const proto = Object.getPrototypeOf(fm);
  if (!proto) return false;
  const orig = proto.openDir;
  if (typeof orig !== "function") return false;
  proto.openDir = async function (p) {
    const r = await orig.call(this, p); // 先在手机上真的打开，成功了才记
    if (p && String(p).startsWith("/")) state.fmPath = String(p).replace(/\/+$/, "") || "/";
    return r;
  };
  proto.__wvbFmHook = true;
  fmHooked = true;
  probe("fm hook ready");
  return true;
}

// 两个按钮在同一个任务里塞进去：绘制只有一次，不会出现"5 个先出来、2 个后补上"
function injectSidebarButtons() {
  const holder = sidebarHolder();
  if (!holder) return false;
  if (ui.sideBrowser.parentNode === holder && ui.sideSettings.parentNode === holder) return true;
  holder.appendChild(ui.sideBrowser);
  holder.appendChild(ui.sideSettings);
  probe("sidebar injected");
  return true;
}

// Vue 什么时候把 aside 渲染出来是不定的：盯着 #app，一出现就把按钮补进去。
// MutationObserver 的回调在绘制前执行，所以原生按钮和我们的一起出现在同一帧。
let sideObs = null;
function watchSidebar() {
  const app = byId("app");
  if (!app || sideObs) return;
  sideObs = new MutationObserver(() => {
    if (ui.sideBrowser.closest("aside")) return;
    injectSidebarButtons();
  });
  sideObs.observe(app, { childList: true, subtree: true });
}

// ---------- 鼠标手势：右键返回、中键回到桌面 ----------
// 原版给画布挂的是 pointerdown / pointerup，而且**不区分按键**：
//   handlePointerDown(t){ ... await this.injectTouch(Et.Down, t) }
// injectTouch 会把 event.buttons 原样发给手机（右键 = 2 = 次要键，中键 = 4 = 第三键）。
// 于是右键在手机上就是一记"次要键按下"，Android 直接弹出上下文菜单；中键则是一记
// "第三键按下"，还会跟 pointerup 配成一次怪异的点击。
// 关键点：pointerdown 与 mousedown 是两条独立的事件流，拦 mousedown 拦不住原版。
// 所以非左键的整条链（pointer → mouse → click → contextmenu）必须在文档捕获阶段
// 一起掐掉，原版一个都收不到，右键/中键就只剩我们自己的手势。
function isMirrorSurface(t) {
  if (!deviceReady() || !t || t.tagName !== "CANVAS") return false;
  return t.id === "wvb-compat-canvas" || t === mirrorCanvas();
}

// 只管非左键：0 是左键，留给原版做点击/拖动
const GESTURE_BUTTONS = new Set([1, 2]);
const GESTURE_EVENTS = ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "auxclick", "click", "contextmenu"];

// 真正下发按键的事件：指针事件优先（Chrome/Edge 都有），没有就走 mousedown
const GESTURE_TRIGGER = typeof window.PointerEvent === "function" ? "pointerdown" : "mousedown";

for (const type of GESTURE_EVENTS) {
  document.addEventListener(
    type,
    (ev) => {
      // 右键/中键按住拖动：原版会把这些 Move 也发给手机，一并掐掉。
      // （pointermove 的 button 恒为 -1，只能看 buttons 位掩码：2 = 右键，4 = 中键）
      if (type === "pointermove") {
        if (!(ev.buttons & 6) || !isMirrorSurface(ev.target)) return;
        ev.stopImmediatePropagation();
        return;
      }
      // contextmenu 的 button 在部分平台是 0，统一按右键处理
      const btn = type === "contextmenu" ? 2 : ev.button;
      if (!GESTURE_BUTTONS.has(btn)) return;
      if (!isMirrorSurface(ev.target)) return;
      ev.preventDefault(); // 挡掉浏览器右键菜单与中键自动滚动
      ev.stopImmediatePropagation(); // 原版的 pointerdown/up 一个都别收到
      if (type !== GESTURE_TRIGGER) return;
      phoneKey(btn === 2 ? "Back" : "Home");
    },
    true
  );
}

// ---------- 文件投递：Ctrl+V（剪贴板是文件）/ 拖入窗口 ----------
// 目标目录由 filepush 判定：文件管理器开着就用它当前目录，否则 /sdcard/Download。
// 传完再刷媒体库，顺序写在 filepush.js 里。
let pasteToken = 0; // 每次 Ctrl+V 一个号；文件粘贴会把它加一，作废文字粘贴
const filePush = createFilePusher({
  shell,
  say,
  probe,
  ready: deviceReady,
  device: () => (window.__pe && window.__pe.device) || null,
  fmOpen,
  fmPath: () => state.fmPath,
  onFilePaste: () => {
    pasteToken++; // 这一次 Ctrl+V 是文件，作废排队中的"文字粘贴"
  },
});
filePush.install();

// ---------- 界面节点：一次绑定；节点位置会被搬动，但引用不变 ----------
function bindChrome() {
  ui.sideBrowser.addEventListener("click", () => setOpen(!state.target));
  ui.sideSettings.addEventListener("click", () => openSettings());
}

function bindMenu() {
  return {
    bar: byId("wvb-bar"),
    url: byId("wvb-url"),
    kbd: byId("wvb-kbd"),
    status: byId("wvb-status"),
    cp: byId("wvb-cp"),
    ps: byId("wvb-ps"),
    back: byId("wvb-back"),
    fwd: byId("wvb-fwd"),
    reload: byId("wvb-reload"),
    go: byId("wvb-go"),
    mode: byId("wvb-mode"),
    orient: byId("wvb-orient"),
    zout: byId("wvb-zout"),
    zval: byId("wvb-zval"),
    zin: byId("wvb-zin"),
    copy: byId("wvb-copy"),
    close: byId("wvb-close"),
    sideBrowser: byId("wvb-side-browser"),
    sideSettings: byId("wvb-side-settings"),
  };
}

const ui = bindMenu();
bindChrome();

// ---------- 阻断扩展自带的全局键盘桥 ----------
// index.js 在 body 上以捕获方式监听 keydown：鼠标停在镜像画面上时，每个按键都被
// 当成"文本"注入手机。中文输入法组合期间会发 key === "Process"（keyCode 229）
// 和拼音字母，于是手机上出现 "Process"、"pppppp" 这种垃圾。这里在源头掐掉：
// 组合中的按键、以及目标是我们自己输入框的按键，一律不转发。
function muteAppKeyBridge() {
  const pe = window.__pe;
  if (!pe || pe.__wvbMuted) return;
  const orig = pe.handleKey;
  if (typeof orig !== "function") return;
  pe.__wvbMuted = true;
  pe.handleKey = function (ev) {
    if (!ev) return;
    if (ev.isComposing || ev.key === "Process" || ev.keyCode === 229) return;
    const t = ev.target;
    if (t && t.closest && (t.closest("#wvb-kbd") || t.closest("#wvb-url") || t.closest("#wvb-settings"))) return;
    return orig.call(this, ev);
  };
  probe("key bridge muted");
}
muteAppKeyBridge();
setTimeout(muteAppKeyBridge, 500);

// 直接在画面上用输入法（不走输入框）时：组合结束把整段文字发过去，
// 组合过程中的按键已经在上面被忽略了，不会再出现 "Process"/"pppppp"
window.addEventListener(
  "compositionend",
  (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#wvb-kbd") || t.closest("#wvb-url") || t.closest("#wvb-settings")) return;
    const text = e.data || "";
    if (text) sendText(text);
  },
  true
);

let sayTimer = 0;
let sayAt = 0;
let sayTone = "";
let statusMsg = "";
let statusTone = "";

// 空闲时这一行也不是空的：画面下方始终有一条固定高度的信息栏，
// 提示来去只换文字，不改变任何尺寸，所以手机画面不会跳。
function idleText() {
  if (!deviceReady()) return "";
  if (state.open) {
    const b = /emmx/i.test(state.browserPkg) ? "Edge" : /chrome/i.test(state.browserPkg) ? "Chrome" : "浏览器";
    return `浏览器模式 · ${b}` + (zhInputReady() ? "" : " · 仅英文输入");
  }
  const i = imeInfo;
  if (zhInputReady()) return "镜像模式 · 手机上操作，这里同步显示";
  if (i && i.broken) {
    return `镜像模式 · 仅显示画面 · ADBKeyboard ${i.version} 不支持 Android ${i.sdk}，请换 v2.5-dev`;
  }
  return "镜像模式 · 仅显示画面 · 装 ADBKeyboard（v2.5-dev）后可输入中文";
}

function setStatus(text, tone) {
  statusMsg = text || "";
  statusTone = text ? tone || "" : "";
  const el = ui.status;
  if (!el) return;
  const out = statusMsg || idleText();
  if (el.textContent !== out) el.textContent = out;
  if (el.dataset.tone !== statusTone) el.dataset.tone = statusTone;
  el.title = out;
}

function say(text, tone) {
  const now = Date.now();
  if (tone === "ok" || tone === "err") {
    sayTone = tone;
    sayAt = now;
  } else if (!tone && sayTone && now - sayAt < 2500) {
    return; // 刚出结果，别被"待机"之类的普通提示顶掉
  }
  clearTimeout(sayTimer);
  setStatus(String(text || ""), tone || "");
  if (!text) return;
  // 提示几秒后回到常驻文字（错误停留久一点，但不会一直挂着）
  sayTimer = setTimeout(() => setStatus("", ""), tone === "err" ? 8000 : 4000);
}

// ---------- 操作栏控件：浏览器模式全量；镜像模式只留有可用通道的部分 ----------
const BROWSER_ONLY = () => [ui.back, ui.fwd, ui.reload, ui.url, ui.go, ui.mode, ui.orient, ui.zout, ui.zval, ui.zin, ui.copy, ui.close];
// 输入框 + 复制 / 粘贴：只有"中文真的能送进手机"时才显示。
// 镜像模式下 scrcpy 1.24 的文本注入与 input text 都只认 ASCII，中文没有通道，
// 留着这几个控件只会让人输入失败，所以整组隐藏（装了 ADBKeyboard 再放出来）。
const INPUT_ONLY = () => [ui.kbd, ui.cp, ui.ps];

function barVisible() {
  return state.open || deviceReady();
}

let barSig = "";
function syncChrome() {
  const vis = barVisible();
  const zhOk = zhInputReady();
  // 镜像模式且没有中文通道时，操作栏上一个可用控件都没有 → 整条隐藏，只留状态行
  const wantBar = vis && (state.open || zhOk);
  // 先停靠再显示：搬动与显示在同一个任务里完成，中间不会有一次绘制
  if (wantBar) positionMenu();
  else undockMenu();
  if (vis) dockStatus();
  const sig = (vis ? "1" : "0") + (state.open ? "1" : "0") + (zhOk ? "1" : "0");
  if (sig !== barSig) {
    barSig = sig;
    for (const el of BROWSER_ONLY()) el.style.display = state.open ? "" : "none";
    for (const el of INPUT_ONLY()) el.style.display = zhOk ? "" : "none";
    ui.sideBrowser.dataset.on = state.open ? "1" : "0";
    setStatus(statusMsg, statusTone);
  }
  ui.bar.style.display = wantBar ? "flex" : "none";
  ui.status.dataset.on = vis ? "1" : "0";
}

// ---------- 后台服务：剪贴板同步 + 下载同步（两种模式都跑） ----------
// 重建基线：基线里已有的文件一律视为"连接前就存在"，永不回传。
// 起点用手机自己的时钟（date +%s）记，避免电脑与手机时钟不一致。
function resetDlBaseline(why) {
  state.dlKey = cfgDirs().join("|");
  state.dlSeeded = false;
  state.dlSeen.clear();
  state.dlPending.clear();
  state.dlRounds = 0;
  state.dlSince = 0;
  probe("dl baseline reset (" + why + ") dirs=" + state.dlKey);
  shell("date +%s")
    .then((out) => {
      const t = parseInt(String(out).trim(), 10);
      if (t > 1000000000) {
        state.dlSince = t;
        probe("dl since=" + t);
      }
    })
    .catch((e) => probe("dl since fail " + (e && e.message)));
}

// fresh=true：刚连上手机，之前残留的基线全部作废（只同步本次连接新增的文件）
function startBackground(fresh) {
  // 通道能力要重新确认（可能刚换了输入法 / 升级了键盘）：保留上一次的结论当占位，
  // 立刻异步再探一次，操作栏不会先缩回去再出来
  imeAt = 0;
  if (deviceReady()) refreshImeGate().catch(() => {});
  clearInterval(state.clipTimer);
  clearInterval(state.dlTimer);
  // fresh 之外，只有监听目录真的变了才重建基线：否则进浏览器模式、保存设置
  // 都会把刚下好的文件当成"旧文件"吞掉。
  if (fresh || state.dlKey !== cfgDirs().join("|")) {
    resetDlBaseline(fresh ? "connect" : "dirs");
  }

  if (state.cfg.clipboard) {
    state.clipTimer = setInterval(() => pollClipboard().catch(() => {}), 700);
    pollClipboard().catch(() => {});
  } else {
    state.clipTimer = 0;
  }

  const scanMs = Math.max(1500, (Number(state.cfg.scanSec) || 4) * 1000);
  if (state.cfg.downloads) {
    state.dlTimer = setInterval(() => pollDownloads().catch(() => {}), scanMs);
    // 立刻建一次基线：之后新增的文件才会被判定为"新"
    pollDownloads().catch(() => {});
  } else {
    state.dlTimer = 0;
  }
  probe(`background on clip=${state.cfg.clipboard} dl=${state.cfg.downloads} scan=${scanMs}`);
}

function stopBackground() {
  clearInterval(state.clipTimer);
  state.clipTimer = 0;
  clearInterval(state.dlTimer);
  state.dlTimer = 0;
  // 断开前把借来的输入法还回去（此时设备还在）
  imeHold = false;
  restoreIme();
  // 断开后基线作废：下次连上时只认"那一次连接之后"新增的文件
  state.dlKey = "";
  state.dlSeeded = false;
  state.dlSeen.clear();
  state.dlPending.clear();
  state.dlSince = 0;
  dropLive();
  probe("background off");
}

// ---------- 收起 File Manager ----------
function fileManagerOpen() {
  return [...document.querySelectorAll("table")].some(
    (t) => (t.textContent || "").indexOf("Modify Time") >= 0 && t.offsetParent !== null
  );
}

function collapseFileManager() {
  if (!fileManagerOpen()) return false;
  const btn = [...document.querySelectorAll("aside button")].find(
    (b) => (b.textContent || "").indexOf("File Manager") >= 0
  );
  if (!btn) return false;
  btn.click();
  probe("collapsed file manager");
  return true;
}

function deviceReady() {
  return !!(window.__pe && window.__pe.device);
}

// 进入浏览器模式时只收起 File Manager（文件表格会盖住画面）。
// Toggle Home Bar 是用户自己的显示偏好，扩展不再替用户改动它。
function collapseSidePanels() {
  collapseFileManager();
  for (const ms of [700, 1600, 3000]) {
    setTimeout(() => {
      if (!state.open) return;
      collapseFileManager();
    }, ms);
  }
  clearInterval(state.fmWatch);
  let lastDev = deviceReady();
  let ticks = 0;
  state.fmWatch = setInterval(() => {
    if (!state.open || ++ticks > 40) {
      clearInterval(state.fmWatch);
      state.fmWatch = 0;
      return;
    }
    const dev = deviceReady();
    if (dev && !lastDev) {
      lastDev = dev;
      collapseFileManager();
      for (const ms of [800, 2000]) {
        setTimeout(() => {
          if (!state.open) return;
          collapseFileManager();
        }, ms);
      }
      return;
    }
    lastDev = dev;
  }, 800);
}

// ---------- 剪贴板：手机 → 电脑 ----------
async function pollClipboard() {
  if (!deviceReady() || !state.cfg.clipboard) return;
  // 连续失败时退避：避免手机停在别的 App 时每 700ms 重开一次 CDP 会话
  if (state.clipSkip > 0) {
    state.clipSkip--;
    return;
  }
  try {
    const cdp = await liveCdp();
    // 每 5 次确认一下这个会话还停在前台标签上（用户可能在手机上切了标签）
    if (++state.clipTick % 4 === 0) {
      const v = await cdp.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });
      if (!v || !v.result || v.result.value !== "visible") {
        dropLive();
        state.clipSkip = 8;
        return;
      }
    }
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        if (!navigator.clipboard || !navigator.clipboard.readText) return Promise.resolve({ ok: false, err: "no-api" });
        return navigator.clipboard.readText()
          .then((t) => ({ ok: true, text: t || "" }))
          .catch((e) => ({ ok: false, err: String((e && e.name) || e) }));
      })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const res = (r.result && r.result.value) || {};
    if (!res.ok) {
      state.clipSkip = 8; // 读不到就先慢下来，别一直敲门
      // 只报一次同样的错，避免刷屏
      if (state.clipErr !== res.err) {
        state.clipErr = res.err;
        probe("clip read fail " + res.err);
        if (res.err === "NotAllowedError") say("手机剪贴板读不到：请让手机停在这个网页上（或手动点一次页面）", "err");
      }
      return;
    }
    state.clipErr = "";
    state.clipSkip = 0;
    const text = res.text || "";
    if (!text || text === state.clipLast) return;
    state.clipLast = text;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      await navigator.clipboard.writeText(text);
    } catch (e) {
      probe("write PC clipboard fail " + (e && e.message));
      say("读到手机剪贴板，但写入电脑失败（窗口未聚焦）", "err");
      return;
    }
    say("手机复制 → 电脑剪贴板：" + text.slice(0, 24), "ok");
    probe("clip " + text.length);
  } catch (e) {
    dropLive();
    // 手机不在浏览器界面：剪贴板读不到，等它回到浏览器后会自动补同步
    const msg = String((e && e.message) || e);
    if (state.clipPause !== msg) {
      state.clipPause = msg;
      probe("clip idle " + msg);
      if (state.open && /还没打开浏览器|没有可见的网页/.test(msg)) {
        say("剪贴板待机：手机当前不在浏览器界面，回到浏览器会自动补同步");
      }
    }
    state.clipSkip = Math.min(40, Math.max(8, (state.clipSkip || 0) * 2));
    return;
  }
  state.clipPause = "";
}

// ---------- 下载：手机常用接收目录（含子目录）→ 电脑 ----------
const DL_SKIP = /\.(crdownload|tmp|part|download|bin|pending)$/i;
const DL_LIST_MAX = 300;

// 监听目录：设置页里每行一个
function cfgDirs() {
  const list = String(state.cfg.dirs || "")
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter((x) => x.startsWith("/"));
  if (list.length) return [...new Set(list)];
  return DEFAULT_CFG.dirs.split("\n");
}

const dlMax = () => Math.max(1, Number(state.cfg.maxMB) || 20) * 1024 * 1024;
const dlWindowMin = () => Math.max(1, Number(state.cfg.days) || 2) * 1440;

const baseName = (p) => String(p || "").split("/").pop();

// 递归列出三个目录里最近改动过的文件（含子目录）
async function listRecentFiles() {
  const dirs = cfgDirs().map((d) => `"${d}"`).join(" ");
  const cmd =
    `for d in ${dirs}; do [ -d "$d" ] || continue; ` +
    `find "$d" -type f -mmin -${dlWindowMin()} -print 2>/dev/null; done`;
  const out = String(await shell(cmd));
  const paths = [...new Set(out.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("/")))];
  probe("scan raw=" + paths.length);
  if (!paths.length) {
    probe("scan empty dirs=" + cfgDirs().join(","));
    return [];
  }
  // 分块 stat：一条命令塞几百个路径在部分设备上会超长/超时
  const raw = [];
  const CHUNK = 100;
  const CAP = 800; // 只处理前 800 个候选，避免超大目录把一轮扫描拖到几十秒
  for (let i = 0; i < paths.length && i < CAP; i += CHUNK) {
    const quoted = paths
      .slice(i, i + CHUNK)
      .map((x) => `"${x.replace(/"/g, '\\"')}"`)
      .join(" ");
    const stat = String(await shell(`stat -c '%s|%Y|%n' ${quoted} 2>/dev/null`));
    for (const line of stat.split("\n")) {
      const m = line.match(/^(\d+)\|(\d+)\|(.+)$/);
      if (m) raw.push({ size: +m[1], mtime: +m[2], path: m[3] });
    }
  }
  // 先按修改时间新→旧，再截断：find 的输出是目录顺序，直接截断会把最新文件切掉
  raw.sort((a, b) => b.mtime - a.mtime);
  const list = raw.slice(0, DL_LIST_MAX);
  probe("scan files=" + list.length + "/" + raw.length + (paths.length > CAP ? " cap=" + paths.length : ""));
  return list;
}

// 后缀 → MIME：Chrome 会按 MIME 决定要不要给文件名补后缀，
// 不指定类型（application/octet-stream）时容易被改成 .bin 之类的错误后缀。
const MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  apk: "application/vnd.android.package-archive",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  amr: "audio/amr",
  epub: "application/epub+zip",
};

function safeName(name) {
  let n = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!n) n = "phone-file-" + Date.now();
  return n.slice(0, 120);
}

async function saveToPC(name, bytes) {
  const fname = safeName(name);
  const ext = (fname.indexOf(".") > 0 ? fname.split(".").pop() : "").toLowerCase();
  const blob = new Blob([bytes], { type: MIME[ext] || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  try {
    if (window.chrome && chrome.downloads && chrome.downloads.download) {
      const id = await new Promise((res) =>
        chrome.downloads.download({ url, filename: fname, saveAs: false, conflictAction: "uniquify" }, (i) => res(i))
      );
      // 复查 Chrome 实际落盘的名字，名字被改动就在界面上说清楚
      if (id !== undefined && window.chrome.downloads.search) {
        setTimeout(() => {
          try {
            chrome.downloads.search({ id }, (items) => {
              const it = items && items[0];
              if (!it || !it.filename) return;
              const finalName = String(it.filename).split(/[\\/]/).pop();
              probe("dl saved as=" + finalName + " want=" + fname + " mime=" + (it.mime || ""));
              if (finalName !== fname && finalName.indexOf(fname.split(".").slice(0, -1).join(".")) !== 0) {
                say("已下载，但 Chrome 另存名为 " + finalName, "err");
              }
            });
          } catch (e) {}
        }, 1200);
      }
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      a.click();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }
}

async function pullFile(f) {
  const name = baseName(f.path);
  if (f.size > dlMax()) {
    say("文件过大，跳过：" + name, "err");
    return;
  }
  say("手机上完成下载，正在取回：" + name);
  try {
    const b64 = String(await shell(`base64 "${f.path}" | tr -d '\\n'`)).replace(/\s+/g, "");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await saveToPC(name, bytes);
    say("已下载到电脑：" + name, "ok");
    probe("downloaded " + name + " " + bytes.length);
  } catch (e) {
    say("取回失败：" + name, "err");
    probe("pull fail " + (e && e.message));
  }
}

// 串行取回：一次只拉一个文件，避免并发把通道挤爆
const pullQueue = [];
let pulling = false;

function enqueuePull(f) {
  if (state.pullingPath === f.path || pullQueue.some((x) => x.path === f.path)) return;
  pullQueue.push(f);
  drainPullQueue();
}

async function drainPullQueue() {
  if (pulling) return;
  pulling = true;
  try {
    while (pullQueue.length && state.cfg.downloads) {
      const f = pullQueue.shift();
      state.pullingPath = f.path;
      try {
        await pullFile(f);
      } catch (e) {
        probe("pull queue fail " + (e && e.message));
      }
      state.pullingPath = "";
    }
  } finally {
    pullQueue.length = 0;
    pulling = false;
  }
}

async function pollDownloads() {
  if (!deviceReady() || !state.cfg.downloads) return;
  // 上一轮还没回来就跳过：大目录扫描可能超过一个间隔，叠着跑会把 USB 通道挤爆
  if (state.dlBusy) {
    probe("dl skip busy");
    return;
  }
  state.dlBusy = true;
  let skippedOld = 0;
  let since = 0;
  let list;
  // 连续失败（USB 掉线、命令超时）时降频，恢复后自动回到正常间隔
  if (state.dlSkip > 0) {
    state.dlSkip--;
    state.dlBusy = false;
    return;
  }
  try {
    list = await listRecentFiles();
  } catch (e) {
    state.dlFail = (state.dlFail || 0) + 1;
    if (state.dlFail >= 2) state.dlSkip = Math.min(6, state.dlFail);
    probe("dl scan fail " + (e && e.message) + " fails=" + state.dlFail);
    state.dlBusy = false;
    return;
  }
  state.dlFail = 0;
  try {
  const now = Date.now() / 1000;
  since = state.dlSince; // 手机时钟的"本次连接起点"
  for (const f of list) {
    if (DL_SKIP.test(f.path) || !f.size) continue;
    // 连接之前就有的文件：只登记，永不排队（留 10 秒容差给秒级取整）
    if (since && f.mtime < since - 10) {
      state.dlSeen.set(f.path, f.size + ":" + f.mtime);
      skippedOld++;
      continue;
    }
    const sig = f.size + ":" + f.mtime;
    const prev = state.dlSeen.get(f.path);
    if (prev === undefined) {
      state.dlSeen.set(f.path, sig);
      // 第一次扫描只登记，不追溯旧文件
      if (state.dlSeeded) state.dlPending.set(f.path, { size: f.size, mtime: f.mtime });
      continue;
    }
    if (prev !== sig) {
      // 同一个路径被重新写入（覆盖下载）：重新排队，等它写完
      state.dlSeen.set(f.path, sig);
      state.dlPending.set(f.path, { size: f.size, mtime: f.mtime });
      continue;
    }
    const pend = state.dlPending.get(f.path);
    if (!pend) continue;
    // 只用"连续几轮完全没变化"来确认写完：不能拿手机 mtime 和电脑时钟比。
    // 手机时钟比电脑快几秒时 now - mtime < 2 会永远成立，文件就永远卡在 pending。
    if (f.size !== pend.size || f.mtime !== pend.mtime) {
      pend.size = f.size;
      pend.mtime = f.mtime;
      pend.age = 0; // 还在写，重新计数
      continue;
    }
    pend.age = (pend.age || 0) + 1;
    if (pend.age < 1) continue; // 下一轮再确认一次
    if (pend.age === 4) {
      probe(`pend slow ${baseName(f.path)} size=${f.size} skew=${Math.round(now - f.mtime)}`);
    }
    state.dlPending.delete(f.path);
    enqueuePull(f);
  }

  // 已经从目录里消失的待取文件不必再等（被删/改名）
  const live = new Set(list.map((x) => x.path));
  for (const p of [...state.dlPending.keys()]) if (!live.has(p)) state.dlPending.delete(p);
  if (state.dlSeen.size > 2000) {
    state.dlSeen.clear();
    for (const x of list) state.dlSeen.set(x.path, x.size + ":" + x.mtime);
  }
  state.dlSeeded = true;
  } finally {
    state.dlBusy = false;
  }
  state.dlRounds++;
  if (state.dlRounds % 5 === 1) {
    probe(`dl poll n=${list.length} seen=${state.dlSeen.size} pend=${state.dlPending.size} q=${pullQueue.length} seeded=${state.dlSeeded} old=${skippedOld} since=${since || 0}`);
  }
}

// ---------- 桌面模式 ----------
async function forceDesktop(reload) {
  try {
    let reloaded = false;
    await withVisibleTab(async (cdp, page) => {
      const id = (page && page.id) || "unknown";
      const first = !state.desktopApplied.has(id);
      await applyEmulation(cdp);
      if (reload && first) {
        state.desktopApplied.add(id);
        if (state.desktopApplied.size > 500) state.desktopApplied.clear();
        await cdp.send("Page.reload", { ignoreCache: false });
        reloaded = true;
      }
    });
    probe("desktop applied reload=" + reloaded);
    return reloaded;
  } catch (e) {
    probe("forceDesktop fail " + (e && e.message));
    return false;
  }
}

async function seedTargets() {
  try {
    const service = await findService();
    if (!service) return;
    const list = await listTargets(() => adbDuplex(service));
    for (const t of list) if (t.type === "page") state.seen.add(t.id);
    if (state.seen.size > 500) state.seen.clear();
    probe("seed targets=" + state.seen.size);
  } catch (e) {}
}

async function watchNewTargets() {
  if (!state.open) return;
  try {
    const service = await findService();
    if (!service) return;
    const list = await listTargets(() => adbDuplex(service));
    const fresh = list.filter((t) => t.type === "page" && /^https?:|^about:/.test(t.url || "") && !state.seen.has(t.id));
    for (const t of fresh) {
      state.seen.add(t.id);
      if (!state.desktop) continue;
      let ws = null;
      try {
        ws = await WebSocket.connect(await adbDuplex(service), wsPathOf(t));
        const cdp = new Cdp(ws);
        const v = await cdp.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });
        if (!v || !v.result || v.result.value !== "visible") continue;
        if (isDesktopUA(await readUA(cdp))) continue;
        await applyEmulation(cdp);
        await cdp.send("Page.reload", { ignoreCache: false });
        probe("new tab -> desktop " + t.id);
      } catch (e) {
        probe("watch tab fail " + (e && e.message));
      } finally {
        try {
          ws && ws.close();
        } catch {}
      }
    }
  } catch (e) {}
}

// ---------- 打开 / 关闭浏览器模式 ----------
// 开、关都是一串"有先后依赖"的手机侧操作，用 Promise 链排队：
// 连点两下只会一次开、一次关，永远不会让"关"的某一步插到"开"的中间。
let switchChain = Promise.resolve();
function serializeSwitch(fn) {
  const run = switchChain.then(fn, fn);
  switchChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

// 关掉手机上的浏览器：没有 root 只能 force-stop；顺带清掉调试端口缓存与会话
async function closePhoneBrowser() {
  const done = [];
  // 先关本次真正用的那个，再兜底清理其余通道
  const list = [...new Set([state.browserPkg, ...BROWSER_PKGS].filter(Boolean))];
  for (const pkg of list) {
    try {
      await shell(`am force-stop ${pkg}`);
      done.push(pkg);
    } catch (e) {}
  }
  state.service = null;
  state.svcAt = 0;
  state.browserPkg = "";
  dropLive();
  probe("browser closed " + done.join(","));
}

// 开启：① 收起 File Manager → ② 拉起手机浏览器 → ③ 横屏 → ④ 全屏
async function enterBrowserMode() {
  state.open = true;
  state.target = true;
  // 浏览器模式用 CDP 输入，手机输入法要还给用户
  imeHold = false;
  restoreIme();
  syncChrome();
  startBackground();
  say("正在连接手机浏览器…");

  // ① 先收起 File Manager，再拉起浏览器，避免文件表格压住画面
  collapseFileManager();

  // ② 拉起手机浏览器（这一步失败就不该继续改横屏/全屏）
  let svc = null;
  try {
    svc = await launchService();
  } catch (e) {
    probe("launch fail " + (e && e.message));
  }
  if (!svc) {
    state.open = false;
    state.target = false;
    syncChrome();
    say("手机上没找到可用的浏览器（Edge 或 Chrome 都行，先在手机上打开一次）", "err");
    return;
  }
  collapseSidePanels(); // 继续延迟收起，防止 Vue 稍后重渲染把面板弹回来

  // ③ 横屏 → ④ 全屏：逐个 await，不并发（顺序反了全屏策略会落空）
  await setLandscape(true);
  await setImmersive(true);
  await setImeSuppress(true);

  await seedTargets();
  const reloaded = await forceDesktop(true);
  if (reloaded) setTimeout(() => setZoom(state.zoom).catch(() => {}), 1200);
  clearInterval(state.watchTimer);
  state.watchTimer = setInterval(watchNewTargets, 2500);
  const url = await currentUrl().catch(() => "");
  if (url) ui.url.value = url;

  paintMode();
  syncChrome();
  say("就绪：手机上正常浏览，Ctrl+C / Ctrl+V 与手机互通", "ok");
}

// 关闭：① 关手机浏览器 → ② 退全屏 → ③ 恢复默认旋转 → ④ 归还原借来的输入法
// （Home Bar 不进这条流程：扩展全程不碰用户的 Toggle Home Bar）
async function exitBrowserMode() {
  state.open = false;
  state.target = false;
  syncChrome();

  clearInterval(state.fmWatch);
  state.fmWatch = 0;
  clearInterval(state.watchTimer);
  state.watchTimer = 0;

  // ① 关掉手机上的浏览器
  await closePhoneBrowser();
  // ② 退出全屏（policy_control 还原）
  await setImmersive(false);
  await setImeSuppress(false);
  // ③ 恢复手机默认的屏幕旋转（横屏是我们改的，必须还回去）
  await setLandscape(false);
  // 临时切过的输入法也还回去
  restoreIme();

  ui.url.value = "";
  paintMode();
  syncChrome();
  say("已退出浏览器模式，手机已恢复默认状态", "ok");
}

function setOpen(open) {
  const want = !!open;
  // 意图必须同步落地：连点两下时第二次点击要能取反，否则两次都会排成"开"
  state.target = want;
  return serializeSwitch(async () => {
    if (want === state.open) {
      syncChrome();
      return;
    }
    await (want ? enterBrowserMode() : exitBrowserMode());
  }).catch((e) => {
    probe("switch fail " + ((e && e.message) || e));
    say("切换失败：" + ((e && e.message) || e), "err");
  });
}

async function currentUrl() {
  return withVisibleTab(async (cdp) => {
    const r = await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    return (r.result && r.result.value) || "";
  });
}

// ---------- 动作 ----------
async function guarded(label, fn) {
  if (state.busy) {
    say("上一个操作还没结束，稍等一下");
    return;
  }
  state.busy = true;
  state.busyAt = Date.now();
  say(label + "…");
  // 看门狗：万一底层卡住（USB 掉线等），不要让按钮永久失效
  const watchdog = setTimeout(() => {
    if (Date.now() - state.busyAt > 25000) {
      state.busy = false;
      probe("busy watchdog " + label);
    }
  }, 26000);
  try {
    await fn();
  } catch (e) {
    say(label + "失败：" + ((e && e.message) || e), "err");
    probe(label + " fail " + (e && e.message));
  } finally {
    clearTimeout(watchdog);
    state.busy = false;
  }
}

ui.go.addEventListener("click", () => {
  const raw = ui.url.value.trim();
  if (!raw) return;
  const url = /^[a-z]+:\/\//i.test(raw) ? raw : "https://" + raw.replace(/^\/+/, "");
  guarded("打开", async () => {
    await shell(`am start -a android.intent.action.VIEW -d "${url}"`).catch(async () => {
      await shell(`am start -a android.intent.action.VIEW -d "${url}" -p com.microsoft.emmx`);
    });
    say("已在手机上打开", "ok");
  });
});
ui.url.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") ui.go.click();
});

ui.copy.addEventListener("click", () =>
  guarded("复制正文", async () => {
    const text = await withVisibleTab(async (cdp) => {
      const r = await cdp.send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
      return (r.result && r.result.value) || "";
    });
    await navigator.clipboard.writeText(text);
    say(`已复制 ${text.length} 字`, "ok");
  })
);

ui.back.addEventListener("click", () =>
  guarded("后退", async () => {
    await withVisibleTab(async (cdp) => cdp.send("Runtime.evaluate", { expression: "history.back()" }));
    say("已后退", "ok");
  })
);
ui.fwd.addEventListener("click", () =>
  guarded("前进", async () => {
    await withVisibleTab(async (cdp) => cdp.send("Runtime.evaluate", { expression: "history.forward()" }));
    say("已前进", "ok");
  })
);
ui.reload.addEventListener("click", () =>
  guarded("刷新", async () => {
    await withVisibleTab(async (cdp) => cdp.send("Page.reload", { ignoreCache: true }));
    say("已刷新", "ok");
  })
);

ui.close.addEventListener("click", () => setOpen(false));

// ---------- 桌面 / 手机、横竖屏、缩放 ----------
function paintMode() {
  ui.mode.textContent = state.desktop ? "桌面" : "手机";
  ui.mode.dataset.on = state.desktop ? "1" : "0";
  ui.orient.textContent = state.landscape ? "横屏" : "竖屏";
  ui.orient.dataset.on = state.landscape ? "1" : "0";
  ui.zval.textContent = Math.round(state.zoom * 100) + "%";
}

ui.mode.addEventListener("click", () =>
  guarded("切换模式", async () => {
    state.desktop = !state.desktop;
    paintMode();
    await withVisibleTab(async (cdp) => {
      await applyEmulation(cdp);
      await cdp.send("Page.reload", { ignoreCache: false });
    });
    say(state.desktop ? "已切到桌面模式（重新加载）" : "已切到手机模式（重新加载）", "ok");
  })
);

ui.orient.addEventListener("click", () =>
  guarded("切换方向", async () => {
    await setLandscape(!state.landscape);
    paintMode();
    say(state.landscape ? "已切到横屏" : "已切到竖屏", "ok");
  })
);

async function setZoom(next) {
  const prev = state.zoom;
  const z = Math.max(0.1, Math.min(2, Math.round(next * 100) / 100));
  state.zoom = z;
  paintMode();
  try {
    await withVisibleTab(async (cdp) => {
      await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: z });
    });
    say("页面缩放 " + Math.round(z * 100) + "%", "ok");
  } catch (e) {
    state.zoom = prev;
    paintMode();
    throw new Error("这台手机不支持页面缩放");
  }
}
ui.zout.addEventListener("click", () => guarded("缩小", () => setZoom(state.zoom - 0.1)));
ui.zin.addEventListener("click", () => guarded("放大", () => setZoom(state.zoom + 0.1)));

// ---------- 输入框：Windows 输入法 → 手机 ----------
let composing = false;
// 聚焦即把手机上的 ADBKeyboard 顶上去（失焦再还回原输入法）：这样中文是"点进来就能打"，
// 不需要等到第一次发送才切换，也不会在连续输入时被 1.5 秒的还原定时器打断。
ui.kbd.addEventListener("focus", async () => {
  imeOnFocus();
  hidePhoneIme();
  try {
    const cdp = await liveCdp();
    const r = await cdp.send("Runtime.evaluate", {
      expression:
        "(()=>{const a=document.activeElement;if(!a)return 'none';const t=a.tagName;const ed=a.isContentEditable||t==='INPUT'||t==='TEXTAREA';return ed?('ok:'+t):('none:'+t)})()",
      returnByValue: true,
    });
    const v = (r.result && r.result.value) || "";
    if (v.indexOf("ok:") === 0) say("已连到手机输入框（" + v.slice(3) + "），直接打字", "ok");
    else say("请先在手机上点一下输入框，再回到这里打字");
  } catch (e) {}
});
ui.kbd.addEventListener("blur", () => imeOnBlur());
ui.kbd.addEventListener("compositionstart", () => {
  composing = true;
});
// 发送失败时把文字留在框里（不吞内容），成功才清空
function sendFromBox(text) {
  if (!text) return;
  ui.kbd.value = "";
  sendText(text).then((ok) => {
    if (!ok && !ui.kbd.value) ui.kbd.value = text;
  });
}

ui.kbd.addEventListener("compositionend", (e) => {
  composing = false;
  sendFromBox(e.data || ui.kbd.value);
});
ui.kbd.addEventListener("input", (e) => {
  if (composing) return;
  const type = e.inputType || "";
  if (type === "insertText") {
    sendFromBox(e.data);
  } else if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertReplacementText") {
    sendFromBox(ui.kbd.value);
  } else if (type.indexOf("delete") === 0) {
    ui.kbd.value = "";
    sendKey("Backspace");
  }
});
ui.kbd.addEventListener("keydown", (e) => {
  if (composing) return;
  const k = e.key;
  if (k === "Enter" || k === "Tab" || k === "Escape" || k === "Delete" || /^Arrow/.test(k)) {
    e.preventDefault();
    e.stopPropagation();
    sendKey(k);
  } else if (k === "Backspace" && !ui.kbd.value) {
    e.preventDefault();
    e.stopPropagation();
    sendKey("Backspace");
  }
});

// ---------- Ctrl+C / Ctrl+V / Ctrl+A：本机 ↔ 手机（镜像模式同样可用） ----------
async function copyPhoneSelection() {
  const text = await withVisibleTab(async (cdp) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: "String(window.getSelection && window.getSelection().toString())",
      returnByValue: true,
    });
    return (r.result && r.result.value) || "";
  });
  if (!text) return say("手机上还没选中文字：在手机页面里长按选择后按 Ctrl+C");
  if (!navigator.clipboard || !navigator.clipboard.writeText) return say("当前页面无法写入剪贴板", "err");
  await navigator.clipboard.writeText(text);
  say("已复制手机选中 " + text.length + " 字", "ok");
}

// Ctrl+A：让手机页面（或页面上聚焦的输入框）全选，接着 Ctrl+C 就能拿走
async function selectAllOnPhone() {
  let n = -1;
  try {
    const cdp = await liveCdp();
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const a = document.activeElement;
        const t = a && a.tagName;
        if (t === "INPUT" || t === "TEXTAREA") { try { a.select(); } catch (e) {} return String(a.value || "").length; }
        if (a && a.isContentEditable) {
          const rg = document.createRange();
          rg.selectNodeContents(a);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(rg);
          return String(sel).length;
        }
        try { document.execCommand("selectAll"); } catch (e) {}
        return String(window.getSelection ? window.getSelection() : "").length;
      })()`,
      returnByValue: true,
      userGesture: true,
    });
    n = Number((r.result && r.result.value) || 0);
  } catch (e) {
    dropLive();
    throw e;
  }
  if (!n) return say("手机上没选中内容（页面可能为空或不可选）", "err");
  say("已全选手机页面 " + n + " 字，按 Ctrl+C 复制到电脑", "ok");
}

async function pasteToPhone() {
  let text = "";
  try {
    text = navigator.clipboard && navigator.clipboard.readText ? await navigator.clipboard.readText() : "";
  } catch (e) {
    probe("readClip fail " + (e && e.message));
  }
  if (!text) return say("电脑剪贴板是空的");
  await sendText(text);
}

ui.cp.addEventListener("click", () => guarded("复制", copyPhoneSelection));
ui.ps.addEventListener("click", () => guarded("粘贴", pasteToPhone));

window.addEventListener(
  "keydown",
  (e) => {
    if (!deviceReady()) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const k = (e.key || "").toLowerCase();
    if (k === "c" && !inField) {
      // 扩展页面上有本地选区时交给浏览器自己复制
      if (String(window.getSelection ? window.getSelection().toString() : "")) return;
      e.preventDefault();
      e.stopPropagation();
      guarded("复制", copyPhoneSelection);
    } else if (k === "v" && !inField) {
      // 剪贴板里可能是文件，也可能只是文字。这里不能先 preventDefault —— 那样浏览器
      // 就不再派发 paste 事件，文件就送不出去了。改成"先让 paste 走一遍"：
      // 文件那条链会 pasteToken++，一个 task 后这里发现被作废就什么都不做；
      // 没人接管说明剪贴板是纯文字，再按老路子把文字打进手机。
      const mine = ++pasteToken;
      setTimeout(() => {
        if (mine !== pasteToken) return;
        guarded("粘贴", pasteToPhone);
      }, 0);
    } else if (k === "a" && !inField) {
      e.preventDefault();
      e.stopPropagation();
      guarded("全选", selectAllOnPhone);
    }
  },
  true
);


// ---------- 设置弹窗 ----------
let settingsEl = null;
let fields = null;

const num = (v, min, max, dflt) => {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
};

function bindSettings() {
  if (settingsEl) return settingsEl;
  const el = byId("wvb-settings");
  settingsEl = el;
  fields = {
    dirs: byId("wvb-dirs"),
    clipboard: byId("wvb-clipboard"),
    downloads: byId("wvb-downloads"),
    maxMB: byId("wvb-maxmb"),
    days: byId("wvb-days"),
    scanSec: byId("wvb-scansec"),
    landscape: byId("wvb-landscape"),
    immersive: byId("wvb-immersive"),
    desktop: byId("wvb-desktop"),
    zoom: byId("wvb-zoom"),
    compat: byId("wvb-compat"),
    browser: byId("wvb-browser"),
    imeAuto: byId("wvb-imeauto"),
  };

  el.addEventListener("mousedown", (e) => {
    if (e.target === el) closeSettings();
  });

  byId("wvb-dlcheck").addEventListener("click", () =>
    guarded("下载自检", async () => {
      if (!deviceReady()) throw new Error("手机未连接");
      const list = await listRecentFiles();
      if (!list.length) {
        const dirs = cfgDirs().map((d) => `"${d}"`).join(" ");
        const raw = String(await shell(`ls -l ${dirs} 2>&1 | head -20`)).trim();
        probe("selfcheck empty ls=" + raw.replace(/\n/g, " ; ").slice(0, 400));
        say(`自检：最近 ${state.cfg.days} 天内没扫到文件（看控制台日志里的 ls 输出）`, "err");
        return;
      }
      const newest = list[0];
      probe("selfcheck ok n=" + list.length + " newest=" + newest.path);
      say(`自检：扫到 ${list.length} 个文件（只有连接后新增的会自动回传），最新 ${baseName(newest.path)} ${Math.round(newest.size / 1024)}KB`, "ok");
    })
  );
  byId("wvb-reset").addEventListener("click", () => fillSettings({ ...DEFAULT_CFG }));
  const keyBtn = byId("wvb-keyreset");
  if (keyBtn)
    keyBtn.addEventListener("click", async () => {
      keyBtn.disabled = true;
      try {
        await resetAdbKey();
        await refreshKeyRow();
        say("已换新密钥：下一轮连接手机会再问一次授权，之后不再问", "ok");
      } catch (e) {
        say("重置密钥失败：" + ((e && e.message) || e), "err");
      } finally {
        keyBtn.disabled = false;
      }
    });
  byId("wvb-cancel").addEventListener("click", () => closeSettings());
  byId("wvb-save").addEventListener("click", () => {
    const f = fields;
    state.cfg = normalizeCfg({
      dirs: f.dirs.value,
      clipboard: f.clipboard.checked,
      downloads: f.downloads.checked,
      maxMB: f.maxMB.value,
      days: f.days.value,
      scanSec: f.scanSec.value,
      landscape: f.landscape.checked,
      immersive: f.immersive.checked,
      desktop: f.desktop.checked,
      zoom: f.zoom.value,
      compat: f.compat.value,
      browser: f.browser.value,
      imeAuto: f.imeAuto.checked,
    });
    persistCfg();
    applyCfg();
    closeSettings();
    say("设置已保存", "ok");
    probe("cfg saved dirs=" + cfgDirs().join(",") + " clip=" + state.cfg.clipboard + " dl=" + state.cfg.downloads);
  });

  // Esc 关闭（只在弹窗打开时生效，不影响快捷键）
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !settingsEl || settingsEl.dataset.open !== "1") return;
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
    },
    true
  );
  return el;
}

function buildSettings() {
  return bindSettings();
}

function fillSettings(cfg) {
  if (!fields) buildSettings();
  fields.dirs.value = String(cfg.dirs || "");
  fields.clipboard.checked = !!cfg.clipboard;
  fields.downloads.checked = !!cfg.downloads;
  fields.maxMB.value = cfg.maxMB;
  fields.days.value = cfg.days;
  fields.scanSec.value = cfg.scanSec;
  fields.landscape.checked = !!cfg.landscape;
  fields.immersive.checked = !!cfg.immersive;
  fields.desktop.checked = !!cfg.desktop;
  fields.zoom.value = cfg.zoom;
  fields.compat.value = cfg.compat || "auto";
  fields.browser.value = cfg.browser || "auto";
  fields.imeAuto.checked = !!cfg.imeAuto;
}

function openSettings() {
  buildSettings();
  fillSettings(state.cfg);
  settingsEl.dataset.open = "1";
  refreshKeyRow();
  probe("settings open");
}

// 设置里那行"电脑密钥"：编号不变 = 手机不会再问
async function refreshKeyRow() {
  const el = byId("wvb-keyid");
  if (!el) return;
  const s = adbKeyStatus();
  if (!s.id) {
    el.textContent = "—";
    return;
  }
  const t = s.created ? new Date(s.created).toLocaleDateString() : "";
  el.textContent = s.id + (t ? " · 生成于 " + t : "");
}

function closeSettings() {
  if (settingsEl) delete settingsEl.dataset.open;
}

// ---------- 配置读写 ----------
function persistCfg() {
  try {
    chrome.storage.local.set({ wvbCfg: state.cfg });
  } catch (e) {
    probe("cfg save fail " + (e && e.message));
  }
}

function normalizeCfg(raw) {
  const c = { ...DEFAULT_CFG, ...(raw || {}) };
  c.dirs = String(c.dirs || "").trim() || DEFAULT_CFG.dirs;
  c.clipboard = !!c.clipboard;
  c.downloads = !!c.downloads;
  c.landscape = !!c.landscape;
  c.immersive = !!c.immersive;
  c.desktop = !!c.desktop;
  c.maxMB = num(c.maxMB, 1, 2048, DEFAULT_CFG.maxMB);
  c.days = num(c.days, 1, 30, DEFAULT_CFG.days);
  c.scanSec = num(c.scanSec, 2, 120, DEFAULT_CFG.scanSec);
  c.zoom = num(c.zoom, 10, 200, DEFAULT_CFG.zoom);
  c.compat = ["auto", "on", "off"].includes(c.compat) ? c.compat : DEFAULT_CFG.compat;
  c.browser = ["auto", "edge", "chrome"].includes(c.browser) ? c.browser : DEFAULT_CFG.browser;
  c.imeAuto = !!c.imeAuto;
  return c;
}

function applyCfg() {
  state.desktop = !!state.cfg.desktop;
  state.zoom = Math.min(2, Math.max(0.1, (Number(state.cfg.zoom) || 50) / 100));
  paintMode();
  // 投屏方式变了：重新判定一次（off 时立刻收掉兼容投屏）
  state.compatSdk = 0;
  if (state.cfg.compat === "off" && compatMirror && compatMirror.on) compatMirror.stop();
  // 换了浏览器偏好：上次的包名与端口缓存都不再可信
  if (state.browserPref !== state.cfg.browser) {
    state.browserPref = state.cfg.browser;
    state.browserPkg = "";
    state.service = null;
    state.svcAt = 0;
    dropLive();
    probe("browser pref " + state.cfg.browser);
  }
  // 输入法选项可能变了（聚焦启用开/关）：通道判定与操作栏都要跟着重来
  imeAt = 0;
  if (!state.cfg.imeAuto && imeHold) {
    imeHold = false;
    restoreIme();
  }
  refreshImeGate().catch(() => {});
  if (state.bg) startBackground(); // 按新间隔/开关重起定时器
}

function loadCfg() {
  try {
    chrome.storage.local.get("wvbCfg", (v) => {
      state.cfg = normalizeCfg((v && v.wvbCfg) || {});
      applyCfg();
      probe("cfg loaded dirs=" + cfgDirs().length);
    });
  } catch (e) {
    applyCfg();
  }
}

// ---------- 兼容投屏：Android 16+ 内置投屏（scrcpy 1.24）起不来时兜底 ----------
// 内置 scrcpy-server 是 1.x 协议，Android 16 移除了 SurfaceControl.createDisplay，
// 服务端直接退出 → 只有黑屏。检测到 API ≥ 36 就切到 screencap 轮询。
let compatMirror = null;

// 内置画布没建出来时，兼容浮层用"画面那一列"的区域（不含已让给操作栏的部分）
function compatRect() {
  const r = stageRect();
  if (!r) return null;
  const bar = ui.bar.getBoundingClientRect();
  const top = ui.bar.style.display !== "none" ? Math.max(r.top, bar.bottom) : r.top;
  return { left: r.left, top, width: r.width, height: Math.max(120, r.bottom - top) };
}

function startCompat(sdk) {
  if (!compatMirror) {
    compatMirror = createCompatMirror({
      shell,
      adbDuplex,
      mirrorCanvas,
      fallbackRect: compatRect,
      onStatus: (m, t) => say(m, t),
    });
  }
  compatMirror.start();
  say(`已启用兼容投屏（内置投屏不支持 Android ${sdk}）：约 2–3 帧/秒，点击/滑动/输入可用`);
  probe("compat on sdk=" + sdk);
}

function syncCompat() {
  if (!deviceReady()) {
    state.compatSdk = 0;
    if (compatMirror && compatMirror.on) compatMirror.stop();
    return;
  }
  if (state.compatSdk || state.compatBusy) return;
  if (state.cfg.compat === "off") {
    state.compatSdk = -1;
    return;
  }
  state.compatBusy = true;
  shell("getprop ro.build.version.sdk")
    .then((out) => {
      const sdk = parseInt(String(out || "").trim(), 10) || 0;
      state.compatSdk = sdk || -1;
      probe("sdk " + sdk);
      if (!sdk) return;
      if (state.cfg.compat === "on" || sdk >= 36) startCompat(sdk);
    })
    .catch((e) => probe("sdk fail " + (e && e.message)))
    .finally(() => {
      state.compatBusy = false;
    });
}

// 设备上线就启动后台服务，下线就停掉；顺带刷新操作栏、状态行与侧栏按钮
setInterval(() => {
  try {
    const ready = deviceReady();
    if (ready && !state.bg) {
      state.bg = true;
      startBackground(true); // 新连接：基线重建，只同步这一轮新增的文件
    } else if (!ready && state.bg) {
      state.bg = false;
      stopBackground();
    }
    syncCompat();
    refreshImeGate();
    injectSidebarButtons(); // Vue 重渲染把按钮冲掉时，这里兜一手
    hookFileManager(); // scrcpy 连上后才能拿到文件管理器，拿到了就记它打开的目录
    syncChrome();
  } catch (e) {
    probe("tick fail " + (e && e.message));
  }
}, 900);

// 关掉扩展页面时尽力把手机恢复原样（输入法、横竖屏、沉浸、软键盘设置）
function cleanupPhone() {
  try {
    imeHold = false;
    restoreIme();
    if (state.imePrev !== null) shell("settings delete secure show_ime_with_hard_keyboard");
    if (state.immersivePrev !== null) {
      const prev = state.immersivePrev;
      state.immersivePrev = null;
      shell(prev && prev !== "null" ? "settings put global policy_control " + prev : "settings delete global policy_control");
    }
    if (state.rotPrev) restoreRotation(state.rotPrev);
  } catch (e) {}
}
// 刷新/关标签前必须把 USB 设备主动关掉：否则新页面拿到的句柄仍被旧文档占着，
// claimInterface 会一直失败，表现就是"刷新后再也连不上"。
function closeDeviceNow() {
  const pe = window.__pe;
  if (!pe) return;
  try {
    pe.client && pe.client.close();
  } catch (e) {}
  try {
    pe.device && pe.device.close();
  } catch (e) {}
  pe.client = undefined;
  pe.device = undefined;
}

window.addEventListener("resize", () => {
  try {
    syncChrome(); // 里面会复核几何
  } catch (e) {}
});
window.addEventListener("pagehide", () => {
  closeDeviceNow();
  cleanupPhone();
});
window.addEventListener("beforeunload", closeDeviceNow);

loadCfg();
paintMode();
syncChrome();
watchSidebar();

// 先把 ADB 密钥准备好：bundle 的 credentialStore 读到"已有密钥"才会复用它；
// 读不到就会 generateKey() 出一把新的，手机立刻把它当成陌生电脑重新授权。
ensureAdbKey()
  .then((s) => {
    probe("adb key " + s.id + " " + s.source);
    refreshKeyRow();
  })
  .catch((e) => probe("adb key fail " + (e && e.message)));

// 诊断模式（localStorage.wvbDebug="1"）下暴露内部方法，便于在控制台逐步复跑
if (DEBUG) {
  window.__wvb = { state, shell, cfgDirs, listRecentFiles, pollDownloads, pullFile, sendText, pushFiles: filePush.pushFiles, targetDir: filePush.targetDir, restart: startBackground };
  probe("debug hooks ready");
}
