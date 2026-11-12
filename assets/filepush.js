// filepush.js — 把电脑上的文件送进手机
//
// 两个入口：Ctrl+V（剪贴板里是文件）与把文件拖进窗口。
//
// 目标目录的判定（顺序即优先级）：
//   ① 原版「File Manager」面板开着，并且我们记下了它当前停在哪一级 → 用那一级
//   ② 其余情况（面板没开／兼容投屏下手机端根本没有文件管理器）→ /sdcard/Download
//
// 传输走 adb 的 sync: 通道，和原版「上传」按钮是同一套协议：
// 二进制安全，不看 shell 转义，也不受 ARG_MAX（命令行长度）限制。
//
// 每个文件的执行顺序：算不冲突的文件名 → 写入 → stat 核对大小 → 记下路径；
// 整批写完后再统一刷新媒体库（先写后扫，避免索引到写了一半的文件）。

const DOWNLOAD = "/sdcard/Download";

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const joinPath = (dir, name) => (dir.endsWith("/") ? dir + name : dir + "/" + name);
const baseName = (n) => String(n || "").split(/[\\/]/).pop() || "file";

const sizeText = (n) =>
  n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";

// /sdcard 可能是 exFAT，这些字符在那边非法；控制字符与开头的点也一并清掉
function safeName(name) {
  const s = String(baseName(name))
    .replace(/[\x00-\x1f<>:"\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\s+$/, "")
    .slice(0, 120);
  return s || "file";
}

// 往 sync 的目标流里写。
// 注意：原版 adb 客户端用的是一份**自带的 WritableStream polyfill**（不是原生实现），
// 原生 ReadableStream.pipeTo() 会做品牌检查，直接报
// "parameter 1 is not of type 'WritableStream'"。
// 所以统一走 getWriter() 手动写入：polyfill 与原生实现都支持，行为一致。
// 64KB 分块是 sync.write() 内部做的（Data 包长度上限），这里不用再切。
async function writeInto(sink, stream) {
  if (!sink || typeof sink.getWriter !== "function") {
    throw new Error("这条连接不支持文件传输");
  }
  const writer = sink.getWriter();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value); // 内部还有一层 64KB 分块，这里不必自己切
    }
    await writer.close(); // close 里才等到手机回 OKAY/FAIL，失败会在这里抛
  } catch (e) {
    try {
      await reader.cancel(e);
    } catch (e2) {}
    try {
      await writer.abort(e);
    } catch (e2) {}
    throw e;
  }
}

export function createFilePusher({ shell, say, probe, ready, device, fmOpen, fmPath, onFilePaste }) {
  let chain = Promise.resolve();
  let installed = false;

  // ---------- 目标目录 ----------
  function targetDir() {
    try {
      if (fmOpen && fmOpen()) {
        const p = String((fmPath && fmPath()) || "").trim().replace(/\/+$/, "");
        if (p && p.startsWith("/")) return p;
      }
    } catch (e) {
      probe("target dir fail " + (e && e.message));
    }
    return DOWNLOAD;
  }

  // ---------- 手机侧小工具 ----------
  async function exists(p) {
    try {
      return String(await shell(`[ -e ${shq(p)} ] && echo 1 || echo 0`)).trim().endsWith("1");
    } catch (e) {
      return false;
    }
  }

  async function sizeOf(p) {
    try {
      const n = parseInt(String(await shell(`stat -c %s ${shq(p)} 2>/dev/null || echo -1`)).trim(), 10);
      return Number.isFinite(n) ? n : -1;
    } catch (e) {
      return -1;
    }
  }

  // 重名不覆盖：name.ext → name-1.ext → name-2.ext …
  async function freePath(dir, name) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 0; i < 50; i++) {
      const cand = i ? `${base}-${i}${ext}` : name;
      const full = joinPath(dir, cand);
      if (!(await exists(full))) return { name: cand, path: full, renamed: i > 0 };
    }
    throw new Error("同名文件过多");
  }

  // ---------- 写入（adb sync SEND）----------
  async function syncPush(path, file) {
    const dev = device && device();
    if (!dev) throw new Error("手机未连接");
    if (typeof dev.sync !== "function") throw new Error("当前连接不支持文件传输");
    let sync = null;
    try {
      sync = await dev.sync();
      // 与原版 uploadFile 一致：普通文件 0666（1<<12 是"常规文件"的类型位）
      const mode = (1 << 12) | 0o666;
      const mtime = Math.floor((file.lastModified || Date.now()) / 1000);
      await writeInto(sync.write(path, mode, mtime), file.stream());
    } finally {
      try {
        if (sync) await sync.dispose();
      } catch (e) {
        probe("sync dispose fail " + (e && e.message));
      }
    }
  }

  // ---------- 媒体库刷新 ----------
  // 先试 MediaStore 的 scan_volume（API 29+ 才有，一次扫完整个卷）；
  // 老系统不支持再退回逐个文件广播 MEDIA_SCANNER_SCAN_FILE。
  async function scanVolume() {
    for (const arg of ["external_primary", "external"]) {
      try {
        const out = String(
          await shell(`content call --uri content://media --method scan_volume --arg ${arg}`)
        );
        if (!/Error|Exception|not found|No content provider|Unknown|does not exist/i.test(out)) {
          probe("scan_volume ok " + arg);
          return true;
        }
      } catch (e) {
        probe("scan_volume fail " + (e && e.message));
      }
    }
    return false;
  }

  async function scanFile(p) {
    try {
      await shell(
        `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shq("file://" + p)}`
      );
      return true;
    } catch (e) {
      probe("scan_file fail " + (e && e.message));
      return false;
    }
  }

  // ---------- 失败原因翻译 ----------
  function explain(e) {
    const m = String((e && e.message) || e || "");
    if (/permission denied|EACCES|Read-only file system|Is a directory/i.test(m)) {
      return "手机上这个目录不可写（Android/data 等受保护目录要换别处）";
    }
    if (/No space left|ENOSPC/i.test(m)) return "手机存储空间不足";
    if (/No such file|ENOENT|does not exist/i.test(m)) return "目标目录不存在（可能在文件管理器里换过目录）";
    if (/Name too long|ENAMETOOLONG/i.test(m)) return "文件名过长";
    if (/not supported|sync/i.test(m)) return "这条连接不支持文件传输";
    return m || "未知错误";
  }

  // ---------- 一批文件 ----------
  async function pushFiles(list) {
    const files = [...list].filter((f) => f && typeof f.size === "number");
    if (!files.length) return;
    if (!ready || !ready()) {
      say("先连上手机再传文件", "err");
      return;
    }

    const dir = targetDir();
    const total = files.length;
    const ok = [];
    const renamed = [];
    const fails = [];

    say(`准备发送 ${total} 个文件到 ${dir}`);
    try {
      await shell(`mkdir -p ${shq(dir)}`); // 目录不存在就建（存在时无副作用）
    } catch (e) {
      probe("mkdir fail " + (e && e.message));
    }

    for (let i = 0; i < total; i++) {
      const f = files[i];
      const label = baseName(f.name);
      if (total > 1) say(`正在发送 ${i + 1}/${total}：${label}（${sizeText(f.size)}）`);
      else say(`正在发送：${label}（${sizeText(f.size)}）`);
      try {
        const t = await freePath(dir, safeName(f.name));
        await syncPush(t.path, f);
        // 写完立刻核对大小：sync 的 OKAY 只代表服务端收完了，不代表落盘完整
        const got = await sizeOf(t.path);
        if (got >= 0 && f.size > 0 && got !== f.size) {
          throw new Error(`写入大小不一致（${got}/${f.size}）`);
        }
        ok.push(t.path);
        if (t.renamed) {
          renamed.push(`${label} → ${t.name}`);
          probe(`push ok(renamed) ${t.path} ${f.size}`);
        } else {
          probe(`push ok ${t.path} ${f.size}`);
        }
      } catch (e) {
        const why = explain(e);
        fails.push(`${label}：${why}`);
        probe(`push fail ${f.name} ${why}`);
      }
    }

    // 媒体库刷新：整批写完再做，一次扫完；扫不动再逐文件广播
    if (ok.length) {
      const vol = await scanVolume();
      if (!vol) for (const p of ok) await scanFile(p);
    }

    if (!fails.length) {
      const extra = renamed.length ? `（重名已改名：${renamed.join("、")}）` : "";
      say(`已发送 ${ok.length} 个文件到 ${dir}${extra}`, "ok");
    } else if (ok.length) {
      say(`已发送 ${ok.length} 个，${fails.length} 个失败：${fails[0]}`, "err");
    } else {
      say(`发送失败：${fails[0]}`, "err");
    }
  }

  function enqueue(list) {
    if (!list || !list.length) return;
    chain = chain
      .then(() => pushFiles(list))
      .catch((e) => {
        probe("push batch fail " + (e && e.message));
        say("发送失败：" + ((e && e.message) || e), "err");
      });
  }

  // ---------- 事件接线 ----------
  function filesFrom(ev) {
    const out = [];
    const dt = ev.clipboardData || ev.dataTransfer;
    if (!dt) return out;
    // items 里能拿到"文件"这一类；个别情况只有 files
    if (dt.items) {
      for (const it of dt.items) {
        if (it.kind === "file") {
          const f = it.getAsFile && it.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    if (!out.length && dt.files) for (const f of dt.files) out.push(f);
    return out;
  }

  function inSettings(t) {
    return !!(t && t.closest && t.closest("#wvb-settings"));
  }

  function install() {
    if (installed) return;
    installed = true;

    // ① Ctrl+V：剪贴板里是文件时接管；是文字就放过去，交给原来的"粘贴到手机"
    document.addEventListener(
      "paste",
      (ev) => {
        if (!ready || !ready()) return;
        if (inSettings(ev.target)) return;
        const files = filesFrom(ev);
        if (!files.length) return; // 纯文字：不拦
        ev.preventDefault();
        ev.stopPropagation();
        if (onFilePaste) onFilePaste();
        probe("paste files " + files.length);
        enqueue(files);
      },
      true
    );

    // ② 拖入窗口
    document.addEventListener(
      "dragover",
      (ev) => {
        if (!ev.dataTransfer) return;
        const types = [...(ev.dataTransfer.types || [])];
        if (!types.includes("Files")) return;
        ev.preventDefault(); // 不拦的话浏览器会直接打开这个文件
        ev.dataTransfer.dropEffect = ready && ready() ? "copy" : "none";
      },
      true
    );

    document.addEventListener(
      "drop",
      (ev) => {
        if (!ev.dataTransfer) return;
        const types = [...(ev.dataTransfer.types || [])];
        if (!types.includes("Files")) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (inSettings(ev.target)) return;
        if (!ready || !ready()) {
          say("先连上手机再传文件", "err");
          return;
        }
        // 文件夹拖进来时 dataTransfer.files 里是"读不出内容"的空壳，先挡掉
        const dirs = [];
        if (ev.dataTransfer.items) {
          for (const it of ev.dataTransfer.items) {
            const ent = it.webkitGetAsEntry && it.webkitGetAsEntry();
            if (ent && ent.isDirectory) dirs.push(ent.name);
          }
        }
        if (dirs.length) {
          say("暂不支持整个文件夹，请拖入其中的文件", "err");
          return;
        }
        const files = filesFrom(ev);
        if (!files.length) return;
        probe("drop files " + files.length);
        enqueue(files);
      },
      true
    );
  }

  return { install, pushFiles: enqueue, targetDir };
}
