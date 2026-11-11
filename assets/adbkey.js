// adbkey.js — 电脑侧 ADB 密钥（决定手机"允许 USB 调试"弹不弹）
//
// 手机只认「公钥」。同一把公钥授权过一次（勾了"始终允许"），以后再连就不再问；
// 换了一把新密钥，手机会当成一台陌生电脑重新弹窗。所以这里的唯一职责是：
// 让扩展用的那把 RSA 私钥固定下来，并且**和 bundle 里的 credentialStore
// 读写同一个存储键**（private-key），这样它永远走"读已有密钥"的分支，
// 不会每次连接都 generateKey() 出一把新的。
//
// 存储位置：chrome.storage.local（扩展页里 bundle 用的就是它）；
// 同时镜像一份到 localStorage，覆盖 bundle 在普通网页里退化成 lg 的情况。

const KEY = "private-key";
const BACKUP = "wvb.adbKey";
const META = "wvb.adbKeyMeta";
const LS_MIRROR = true;

const hasExt = () => {
  try {
    return typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local);
  } catch (e) {
    return false;
  }
};

function extGet(keys) {
  return new Promise((res) => {
    try {
      chrome.storage.local.get(keys, (v) => res(v || {}));
    } catch (e) {
      res({});
    }
  });
}

function extSet(obj) {
  return new Promise((res) => {
    try {
      chrome.storage.local.set(obj, () => res(true));
    } catch (e) {
      res(false);
    }
  });
}

function extRemove(keys) {
  return new Promise((res) => {
    try {
      chrome.storage.local.remove(keys, () => res(true));
    } catch (e) {
      res(false);
    }
  });
}

function lsGet(k) {
  try {
    return localStorage.getItem(k) || "";
  } catch (e) {
    return "";
  }
}

function lsSet(k, v) {
  if (!LS_MIRROR) return;
  try {
    localStorage.setItem(k, v);
  } catch (e) {}
}

function lsDel(k) {
  try {
    localStorage.removeItem(k);
  } catch (e) {}
}

// PKCS#8 → base64（bundle 里 Ql() 解的就是这个格式）
function b64(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < u.length; i += step) s += String.fromCharCode.apply(null, u.subarray(i, i + step));
  return btoa(s);
}

// 密钥编号：同一把密钥永远是同一串，换密钥必变。用来判断"这次有没有被重新生成"
async function keyId(text) {
  try {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    let s = "";
    for (let i = 0; i < 8; i++) s += d[i].toString(16).padStart(2, "0");
    return s;
  } catch (e) {
    return "";
  }
}

// 参数与 bundle 完全一致（RSA-2048 / SHA-1 / e=65537），否则 importKey 会失败
async function newKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["sign", "verify"]
  );
  return b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
}

let status = { id: "", created: 0, source: "" };

export function adbKeyStatus() {
  return { ...status };
}

// 启动时调用一次：有密钥就沿用（并补齐备份），没有才生成
export async function ensureAdbKey() {
  if (!(typeof crypto !== "undefined" && crypto.subtle)) return status;
  const ext = hasExt();
  let cur = "";
  let created = 0;

  if (ext) {
    const v = await extGet([KEY, BACKUP, META]);
    cur = String(v[KEY] || "");
    const meta = v[META];
    if (meta && meta.created) created = Number(meta.created) || 0;
    if (!cur && v[BACKUP]) cur = String(v[BACKUP]); // 主键被单独清掉：从备份恢复
  }
  if (!cur) cur = lsGet(KEY);
  if (!cur) cur = lsGet(BACKUP);

  let source = "existing";
  if (!cur) {
    try {
      cur = await newKey();
      created = Date.now();
      source = "generated";
    } catch (e) {
      console.warn("[wvb] 生成 ADB 密钥失败", e);
      return status;
    }
  }

  if (ext) await extSet({ [KEY]: cur, [BACKUP]: cur, [META]: { created } });
  lsSet(KEY, cur);
  lsSet(BACKUP, cur);

  status = { id: await keyId(cur), created, source };
  return status;
}

// 换一把新密钥（下一轮连接手机会再问一次）
export async function resetAdbKey() {
  const ext = hasExt();
  if (ext) await extRemove([KEY, BACKUP, META]);
  lsDel(KEY);
  lsDel(BACKUP);
  status = { id: "", created: 0, source: "" };
  return ensureAdbKey();
}

try {
  window.__wvbKey = { status: adbKeyStatus, ensure: ensureAdbKey, reset: resetAdbKey };
} catch (e) {}
