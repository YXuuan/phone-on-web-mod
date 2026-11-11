// compat.js — Android 16+ 兼容投屏
// 内置投屏走的是内嵌 scrcpy-server 1.24（1.x 协议）。Android 16 移除了
// android.view.SurfaceControl.createDisplay(String, boolean)，服务端一启动就抛
// NoSuchMethodException 直接退出，扩展端只会看到"没有画面"。
// 这里用最原始的 screencap 轮询 + input 注入兜底：任何 Android 版本都能用，
// 代价是帧率低（约 2–3 帧/秒），足够看网页、点链接、滚动。

const FRAME_MS = 380; // 目标帧间隔
const SHOT_MS = 4000; // 单帧总超时

export function createCompatMirror({ shell, adbDuplex, mirrorCanvas, fallbackRect, onStatus }) {
  const st = {
    on: false,
    timer: 0,
    wrap: null,
    canvas: null,
    ctx: null,
    label: null,
    fit: null, // { s, ox, oy }
    size: null, // 手机像素 { w, h }
    frames: 0,
    fpsAt: 0,
    fps: 0,
    err: "",
    wheelAt: 0,
    down: null,
  };

  const say = (m, t) => {
    try {
      onStatus && onStatus(m, t);
    } catch (e) {}
  };

  // ---------- 读一段 adb 服务（二进制安全） ----------
  function readAll(service, limit) {
    const max = limit || 12 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let settled = false;
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("读取超时"));
      }, SHOT_MS);
      (async () => {
        const sock = await adbDuplex(service);
        const chunks = [];
        let total = 0;
        try {
          for (;;) {
            const v = await sock.read();
            if (!v || !v.length) break;
            chunks.push(v);
            total += v.length;
            if (total > max) break;
          }
        } finally {
          sock.close();
        }
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.length;
        }
        return out;
      })().then(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          reject(e);
        }
      );
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || "").replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const isPng = (b) => b && b.length > 200 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

  // ---------- 取一帧 ----------
  async function grabPng() {
    // exec: 不走 pty，二进制是干净的；个别 adbd 不支持就退回 base64
    try {
      const b = await readAll("exec:screencap -p");
      if (isPng(b)) return b;
    } catch (e) {}
    const txt = String(await shell("screencap -p | base64 | tr -d '\\n'")).trim();
    const b = b64ToBytes(txt);
    if (isPng(b)) return b;
    throw new Error("截屏数据无效");
  }

  // ---------- 浮层：结构在 index.html（#wvb-compat），这里只取节点 ----------
  function bind() {
    if (st.wrap) return;
    const wrap = document.getElementById("wvb-compat");
    const canvas = document.getElementById("wvb-compat-canvas");
    if (!wrap || !canvas) return;
    st.wrap = wrap;
    st.canvas = canvas;
    st.ctx = canvas.getContext("2d");
    st.label = document.getElementById("wvb-compat-fps");

    const onBtn = (id, fn) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    };
    onBtn("wvb-compat-back", () => keyevent(4));
    onBtn("wvb-compat-home", () => goHome());
    onBtn("wvb-compat-switch", () => keyevent(187));

    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {}
      st.down = { x: e.clientX, y: e.clientY, t: Date.now() };
      e.preventDefault();
    });
    canvas.addEventListener("pointerup", (e) => {
      const d = st.down;
      st.down = null;
      if (!d) return;
      const a = toPhone(d.x, d.y);
      if (!a) return;
      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (dist < 8) {
        tap(a.x, a.y);
        return;
      }
      const b = toPhone(e.clientX, e.clientY);
      if (!b) return;
      const dur = Math.min(600, Math.max(120, Date.now() - d.t));
      swipe(a.x, a.y, b.x, b.y, dur);
    });
    canvas.addEventListener("pointercancel", () => {
      st.down = null;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const now = Date.now();
        if (now - st.wheelAt < 260) return;
        st.wheelAt = now;
        const s = st.size;
        if (!s) return;
        const dir = e.deltaY > 0 ? 1 : -1;
        const cx = Math.round(s.w / 2);
        const cy = Math.round(s.h / 2);
        const to = Math.max(24, Math.min(s.h - 24, cy - dir * Math.round(s.h * 0.36)));
        swipe(cx, cy, cx, to, 190); // 手指上滑 = 内容下滚
      },
      { passive: false }
    );
  }

  // 把浮层对齐到镜像画布的位置：让应用自己那层画布完全被盖住
  function place() {
    if (!st.wrap) return false;
    let r = null;
    const c = mirrorCanvas();
    if (c) {
      const b = c.getBoundingClientRect();
      if (b.width >= 40 && b.height >= 40) r = b;
    }
    if (!r && fallbackRect) {
      // 内置投屏根本没建出画布时，退到"画面那一列"的区域
      const b = fallbackRect();
      if (b && b.width >= 40 && b.height >= 40) r = b;
    }
    if (!r) {
      st.wrap.dataset.on = "0";
      return false;
    }
    st.wrap.dataset.on = "1";
    Object.assign(st.wrap.style, {
      left: Math.round(r.left) + "px",
      top: Math.round(r.top) + "px",
      width: Math.round(r.width) + "px",
      height: Math.round(r.height) + "px",
    });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round(r.width * dpr));
    const bh = Math.max(1, Math.round(r.height * dpr));
    if (st.canvas.width !== bw || st.canvas.height !== bh) {
      st.canvas.width = bw;
      st.canvas.height = bh;
    }
    return true;
  }

  function draw(bmp) {
    const cv = st.canvas;
    const cw = cv.width;
    const ch = cv.height;
    if (!cw || !ch) return;
    const iw = bmp.width;
    const ih = bmp.height;
    if (!iw || !ih) return;
    const s = Math.min(cw / iw, ch / ih);
    const dw = Math.max(1, Math.round(iw * s));
    const dh = Math.max(1, Math.round(ih * s));
    const ox = Math.round((cw - dw) / 2);
    const oy = Math.round((ch - dh) / 2);
    st.fit = { s, ox, oy };
    st.size = { w: iw, h: ih };
    const ctx = st.ctx;
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, ox, oy, dw, dh);
  }

  function toPhone(clientX, clientY) {
    const cv = st.canvas;
    const f = st.fit;
    const size = st.size;
    if (!cv || !f || !size) return null;
    const r = cv.getBoundingClientRect();
    const k = cv.width / Math.max(1, r.width);
    const x = (clientX - r.left) * k;
    const y = (clientY - r.top) * k;
    const px = Math.round((x - f.ox) / f.s);
    const py = Math.round((y - f.oy) / f.s);
    if (px < 0 || py < 0 || px > size.w || py > size.h) return null;
    return { x: px, y: py };
  }

  // ---------- 注入 ----------
  function fire(cmd) {
    shell(cmd)
      .then((out) => {
        const t = String(out || "");
        if (st.err !== "inject" && /SecurityException|INJECT_EVENTS|not allowed/i.test(t)) {
          st.err = "inject";
          say("手机拒绝了点击注入：设置 → 开发者选项 → 打开「USB 调试（安全设置）」", "err");
        }
      })
      .catch(() => {});
  }
  const tap = (x, y) => fire(`input tap ${x} ${y}`);
  const swipe = (x1, y1, x2, y2, ms) => fire(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
  const keyevent = (code) => fire(`input keyevent ${code}`);
  // HOME 不能只靠 input keyevent：MIUI 没开「USB 调试（安全设置）」时会静默丢弃。
  // am start 直接把桌面的 MAIN/HOME Activity 拉到前台，不依赖输入注入。
  const goHome = () => {
    shell("am start -a android.intent.action.MAIN -c android.intent.category.HOME")
      .then((out) => {
        if (/Error|Exception|Permission Denial|not found/i.test(String(out || ""))) keyevent(3);
      })
      .catch(() => keyevent(3));
  };

  // ---------- 帧循环 ----------
  async function tick() {
    if (!st.on) return;
    const t0 = Date.now();
    if (document.visibilityState === "visible" && place()) {
      try {
        const png = await grabPng();
        const bmp = await createImageBitmap(new Blob([png], { type: "image/png" }));
        draw(bmp);
        if (bmp.close) bmp.close();
        st.frames++;
        if (st.err === "grab") st.err = "";
      } catch (e) {
        if (st.err !== "grab") {
          st.err = "grab";
          say("兼容投屏取画面失败：" + ((e && e.message) || e), "err");
        }
      }
    }
    const now = Date.now();
    if (now - st.fpsAt > 2000) {
      st.fps = Math.round((st.frames * 1000) / Math.max(1, now - st.fpsAt));
      st.frames = 0;
      st.fpsAt = now;
      if (st.label && st.size) {
        st.label.textContent = `兼容投屏 ${st.fps}fps ${st.size.w}×${st.size.h}`;
      }
    }
    st.timer = setTimeout(tick, Math.max(120, FRAME_MS - (Date.now() - t0)));
  }

  function start() {
    bind();
    if (!st.wrap) return;
    if (st.on) return;
    st.on = true;
    st.frames = 0;
    st.fpsAt = Date.now();
    st.wrap.dataset.on = "1";
    if (st.label && !st.size) st.label.textContent = "兼容投屏…";
    place();
    tick();
  }

  function stop() {
    st.on = false;
    clearTimeout(st.timer);
    st.timer = 0;
    if (st.wrap) st.wrap.dataset.on = "0";
  }

  return {
    start,
    stop,
    get on() {
      return st.on;
    },
  };
}
