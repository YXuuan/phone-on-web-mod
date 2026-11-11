// cdp-core.js — 传输无关的 HTTP / WebSocket / CDP 客户端
// duplex: { read(): Promise<Uint8Array>, write(bytes): Promise<void>, close(): void }

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

export class ByteReader {
  constructor(duplex) {
    this.duplex = duplex;
    this.buf = new Uint8Array(0);
    this.eof = false;
  }
  append(chunk) {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }
  async fill() {
    if (this.eof) throw new Error("stream closed");
    const chunk = await this.duplex.read();
    if (!chunk || chunk.length === 0) {
      this.eof = true;
      throw new Error("stream closed");
    }
    this.append(chunk);
  }
  async take(n) {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  async until(marker) {
    const needle = typeof marker === "string" ? enc.encode(marker) : marker;
    for (;;) {
      const idx = indexOf(this.buf, needle);
      if (idx >= 0) {
        const out = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + needle.length);
        return out;
      }
      await this.fill();
    }
  }
}

function indexOf(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

async function readChunked(reader) {
  const parts = [];
  for (;;) {
    const line = dec.decode(await reader.until("\r\n"));
    const size = parseInt(line.split(";")[0].trim(), 16);
    if (!size) {
      await reader.until("\r\n");
      break;
    }
    parts.push(await reader.take(size));
    await reader.take(2);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export async function httpRequest(duplex, method, path, extraHeaders = {}) {
  const reader = new ByteReader(duplex);
  const lines = [`${method} ${path} HTTP/1.1`, "Host: localhost", "Connection: close"];
  for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`);
  await duplex.write(enc.encode(lines.join("\r\n") + "\r\n\r\n"));

  const head = dec.decode(await reader.until("\r\n\r\n"));
  const rows = head.split("\r\n");
  const status = parseInt(rows[0].split(" ")[1], 10);
  const headers = {};
  for (const row of rows.slice(1)) {
    const i = row.indexOf(":");
    if (i > 0) headers[row.slice(0, i).trim().toLowerCase()] = row.slice(i + 1).trim();
  }

  let body = new Uint8Array(0);
  try {
    if ((headers["transfer-encoding"] || "").includes("chunked")) {
      body = await readChunked(reader);
    } else if (headers["content-length"]) {
      body = await reader.take(parseInt(headers["content-length"], 10));
    }
  } catch {
    /* 有些端点直接关连接，拿不到 body 也不算失败 */
  }
  return { status, headers, body, text: dec.decode(body) };
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function randomKey() {
  const b = new Uint8Array(16);
  (globalThis.crypto || {}).getRandomValues?.(b) || b.forEach((_, i) => (b[i] = (Math.random() * 256) | 0));
  return b64(b);
}

function frame(payload, opcode) {
  const len = payload.length;
  const mask = new Uint8Array(4);
  (globalThis.crypto || {}).getRandomValues?.(mask) || mask.forEach((_, i) => (mask[i] = (Math.random() * 256) | 0));

  let head;
  if (len < 126) {
    head = new Uint8Array(6);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = new Uint8Array(8);
    head[1] = 0x80 | 126;
    new DataView(head.buffer).setUint16(2, len);
  } else {
    head = new Uint8Array(14);
    head[1] = 0x80 | 127;
    new DataView(head.buffer).setBigUint64(2, BigInt(len));
  }
  head[0] = 0x80 | opcode;
  head.set(mask, head.length - 4);

  const out = new Uint8Array(head.length + len);
  out.set(head);
  for (let i = 0; i < len; i++) out[head.length + i] = payload[i] ^ mask[i & 3];
  return out;
}

export class WebSocket {
  constructor(duplex, reader) {
    this.duplex = duplex;
    this.reader = reader;
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
    this._loop();
  }

  static async connect(duplex, path) {
    const reader = new ByteReader(duplex);
    const key = randomKey();
    const req = [
      `GET ${path} HTTP/1.1`,
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n");
    await duplex.write(enc.encode(req));
    const head = dec.decode(await reader.until("\r\n\r\n"));
    const status = parseInt(head.split(" ")[1], 10);
    if (status !== 101) throw new Error(`WebSocket 握手失败: ${head.split("\r\n")[0]}`);
    return new WebSocket(duplex, reader);
  }

  send(text) {
    if (this.closed) throw new Error("socket closed");
    const r = this.duplex.write(frame(enc.encode(text), 1));
    if (r && r.catch) r.catch(() => {});
  }

  async _loop() {
    try {
      for (;;) {
        const b0 = await this.reader.take(2);
        const opcode = b0[0] & 0x0f;
        const masked = (b0[1] & 0x80) !== 0;
        let len = b0[1] & 0x7f;
        if (len === 126) len = new DataView((await this.reader.take(2)).buffer).getUint16(0);
        else if (len === 127) len = Number(new DataView((await this.reader.take(8)).buffer).getBigUint64(0));
        const maskKey = masked ? await this.reader.take(4) : null;
        let payload = len ? await this.reader.take(len) : new Uint8Array(0);
        if (maskKey) {
          const copy = new Uint8Array(payload.length);
          for (let i = 0; i < payload.length; i++) copy[i] = payload[i] ^ maskKey[i & 3];
          payload = copy;
        }
        if (opcode === 8) break;
        if (opcode === 9) {
          this.duplex.write(frame(payload, 10));
          continue;
        }
        if (opcode === 1 && this.onmessage) this.onmessage(dec.decode(payload));
      }
    } catch {
      /* 连接断开 */
    }
    this.closed = true;
    if (this.onclose) this.onclose();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      const r = this.duplex.write(frame(new Uint8Array(0), 8));
      if (r && r.catch) r.catch(() => {});
    } catch {}
    this.duplex.close();
  }
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this._closeFns = [];
    ws.onmessage = (text) => this._dispatch(text);
    ws.onclose = () => {
      this.closed = true;
      // 连接断了就立刻让所有等待中的请求失败，避免上层卡到超时
      for (const p of this.pending.values()) {
        try {
          p.reject(new Error("调试连接已断开"));
        } catch {}
      }
      this.pending.clear();
      for (const fn of this._closeFns) {
        try {
          fn();
        } catch {}
      }
    };
  }

  onClose(fn) {
    this._closeFns.push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }

  _dispatch(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) || []) {
        try {
          fn(msg.params || {});
        } catch {}
      }
    }
  }

  on(event, fn) {
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error("调试连接已断开"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, timeoutMs);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }
}

export async function listTargets(openDuplex) {
  const duplex = await openDuplex();
  try {
    const res = await httpRequest(duplex, "GET", "/json/list");
    if (res.status !== 200) throw new Error(`/json/list 返回 ${res.status}`);
    return JSON.parse(res.text);
  } finally {
    duplex.close();
  }
}

export async function newTarget(openDuplex, url = "about:blank") {
  const duplex = await openDuplex();
  try {
    const res = await httpRequest(duplex, "PUT", `/json/new?${encodeURIComponent(url)}`);
    if (res.status >= 300) throw new Error(`/json/new 返回 ${res.status}`);
    return JSON.parse(res.text);
  } finally {
    duplex.close();
  }
}

export function wsPathOf(target) {
  const url = target.webSocketDebuggerUrl || "";
  const i = url.indexOf("/devtools/");
  if (i >= 0) return url.slice(i);
  return `/devtools/page/${target.id}`;
}
