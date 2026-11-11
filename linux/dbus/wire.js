'use strict';
//
// The D-Bus wire format, and nothing else: type signatures, marshalling, and message framing.
// No sockets and no packages here, so every function can be tested on any machine.
//
// The bus is treated as untrusted input. Every length is checked against the buffer before it is used, nesting is
// capped, strings must be valid UTF-8 without NUL, and a message over the size limit is refused before it is buffered.
//
// JavaScript values:
//   y n q i u d      number          b  boolean         x t   BigInt (a number is accepted when writing)
//   s o g            string          ay Buffer          a{kv} Map (a plain object or [[k, v]] is accepted when writing)
//   a(...)  array    (...)  array of the fields         v     Variant
//
const MAX_MESSAGE = 4 * 1024 * 1024;   // the spec allows 128 MiB; a tray needs a tiny fraction of that
const MAX_ARRAY = 1024 * 1024;         // the spec allows 64 MiB
const MAX_DEPTH = 32;

class DBusError extends Error {
  constructor(message, name) { super(message); this.name = 'DBusError'; this.dbusName = name || 'org.freedesktop.DBus.Error.Failed'; }
}

class Variant {
  constructor(sig, value) { this.sig = sig; this.value = value; }
}

// ---------- signatures ----------

const BASIC = 'ybnqiuxtdsog';
const ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, v: 1, a: 4, '(': 8, '{': 8 };

function parseOne(sig, pos, depth) {
  if (depth > MAX_DEPTH) throw new DBusError('signature nested too deeply');
  const c = sig[pos];
  if (c === undefined) throw new DBusError('signature ends early');
  if (BASIC.includes(c) || c === 'v') return { type: { t: c }, next: pos + 1 };
  if (c === 'a') {
    const inner = parseOne(sig, pos + 1, depth + 1);
    return { type: { t: 'a', elem: inner.type }, next: inner.next };
  }
  if (c === '(') {
    const fields = [];
    let p = pos + 1;
    while (sig[p] !== ')') {
      if (p >= sig.length) throw new DBusError('struct is not closed');
      const f = parseOne(sig, p, depth + 1);
      if (f.type.t === '{') throw new DBusError('a dict entry may only appear inside an array');
      fields.push(f.type);
      p = f.next;
    }
    if (!fields.length) throw new DBusError('empty struct');
    return { type: { t: '(', fields }, next: p + 1 };
  }
  if (c === '{') {
    const k = parseOne(sig, pos + 1, depth + 1);
    if (!BASIC.includes(k.type.t)) throw new DBusError('dict key must be a basic type');
    const v = parseOne(sig, k.next, depth + 1);
    if (v.type.t === '{') throw new DBusError('a dict entry may only appear inside an array');
    if (sig[v.next] !== '}') throw new DBusError('dict entry is not closed');
    return { type: { t: '{', key: k.type, value: v.type }, next: v.next + 1 };
  }
  throw new DBusError('unknown type code ' + JSON.stringify(c));
}

/** A signature string (possibly several complete types) to a list of type trees. Cached; the cache is bounded. */
const sigCache = new Map();
function parseSignature(sig) {
  if (typeof sig !== 'string' || sig.length > 255) throw new DBusError('bad signature');
  const hit = sigCache.get(sig);
  if (hit) return hit;
  const out = [];
  let pos = 0;
  while (pos < sig.length) {
    const r = parseOne(sig, pos, 0);
    if (r.type.t === '{') throw new DBusError('a dict entry may only appear inside an array');
    out.push(r.type);
    pos = r.next;
  }
  if (sigCache.size > 512) sigCache.clear();
  sigCache.set(sig, out);
  return out;
}

/** One complete type as text again. */
function typeToString(t) {
  switch (t.t) {
    case 'a': return 'a' + typeToString(t.elem);
    case '(': return '(' + t.fields.map(typeToString).join('') + ')';
    case '{': return '{' + typeToString(t.key) + typeToString(t.value) + '}';
    default: return t.t;
  }
}

// ---------- validation helpers ----------

const NAME_PART = /^[A-Za-z_][A-Za-z0-9_]*$/;
function validObjectPath(p) {
  if (p === '/') return true;
  if (typeof p !== 'string' || p[0] !== '/' || p.endsWith('/') || p.length > 255) return false;
  return p.slice(1).split('/').every((s) => NAME_PART.test(s));
}
function validInterfaceName(n) {
  if (typeof n !== 'string' || n.length > 255) return false;
  const parts = n.split('.');
  return parts.length >= 2 && parts.every((s) => NAME_PART.test(s));
}
function validMemberName(n) { return typeof n === 'string' && n.length > 0 && n.length <= 255 && NAME_PART.test(n); }
function validBusName(n) {
  if (typeof n !== 'string' || n.length > 255 || n.length < 3) return false;
  const unique = n[0] === ':';
  const parts = (unique ? n.slice(1) : n).split('.');
  return parts.length >= 2 && parts.every((s) => (unique ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z_-][A-Za-z0-9_-]*$/).test(s));
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
function decodeString(buf) {
  if (buf.includes(0)) throw new DBusError('string contains NUL');
  try { return UTF8.decode(buf); } catch (e) { throw new DBusError('string is not valid UTF-8'); }
}

// ---------- writer ----------

class Writer {
  constructor() { this.buf = Buffer.alloc(256); this.len = 0; }
  _grow(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    if (size > MAX_MESSAGE * 2) throw new DBusError('message too large');
    const nb = Buffer.alloc(size);
    this.buf.copy(nb, 0, 0, this.len);
    this.buf = nb;
  }
  align(n) {
    const pad = (n - (this.len % n)) % n;
    if (pad) { this._grow(pad); this.buf.fill(0, this.len, this.len + pad); this.len += pad; }
  }
  _num(size, fn) { this.align(size); this._grow(size); fn(this.buf, this.len); this.len += size; }
  bytes(b) { this._grow(b.length); b.copy ? b.copy(this.buf, this.len) : this.buf.set(b, this.len); this.len += b.length; }
  u8(v) { this._grow(1); this.buf[this.len++] = v; }
  u32(v) { this._num(4, (b, o) => b.writeUInt32LE(v >>> 0, o)); }
  result() { return this.buf.subarray(0, this.len); }

  write(type, v, depth = 0) {
    if (depth > MAX_DEPTH) throw new DBusError('value nested too deeply');
    switch (type.t) {
      case 'y': return this._int(v, 0, 255, () => this.u8(v));
      case 'b': this.u32(v ? 1 : 0); return;
      case 'n': return this._int(v, -32768, 32767, () => this._num(2, (b, o) => b.writeInt16LE(v, o)));
      case 'q': return this._int(v, 0, 65535, () => this._num(2, (b, o) => b.writeUInt16LE(v, o)));
      case 'i': return this._int(v, -2147483648, 2147483647, () => this._num(4, (b, o) => b.writeInt32LE(v, o)));
      case 'u': return this._int(v, 0, 4294967295, () => this.u32(v));
      case 'x': return this._num(8, (b, o) => b.writeBigInt64LE(BigInt(v), o));
      case 't': return this._num(8, (b, o) => b.writeBigUInt64LE(BigInt(v), o));
      case 'd': if (typeof v !== 'number') throw new DBusError('expected a number for d'); return this._num(8, (b, o) => b.writeDoubleLE(v, o));
      case 's': return this._str(v, 4);
      case 'o': if (!validObjectPath(v)) throw new DBusError('bad object path ' + JSON.stringify(v)); return this._str(v, 4);
      case 'g': parseSignature(v); return this._str(v, 1);
      case 'v': {
        if (!(v instanceof Variant)) throw new DBusError('expected a Variant');
        const types = parseSignature(v.sig);
        if (types.length !== 1) throw new DBusError('a variant holds exactly one value');
        this._str(v.sig, 1);
        return this.write(types[0], v.value, depth + 1);
      }
      case 'a': return this._array(type, v, depth);
      case '(': {
        if (!Array.isArray(v) || v.length !== type.fields.length) throw new DBusError('struct needs ' + type.fields.length + ' fields');
        this.align(8);
        type.fields.forEach((f, i) => this.write(f, v[i], depth + 1));
        return;
      }
      default: throw new DBusError('cannot write type ' + type.t);
    }
  }
  _int(v, lo, hi, fn) {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new DBusError('integer out of range: ' + v);
    fn();
  }
  _str(s, lenSize) {
    if (typeof s !== 'string') throw new DBusError('expected a string');
    const b = Buffer.from(s, 'utf8');
    if (b.includes(0)) throw new DBusError('string contains NUL');
    if (lenSize === 4) this.u32(b.length); else this.u8(b.length);
    this.bytes(b);
    this.u8(0);
  }
  _array(type, v, depth) {
    const elem = type.elem;
    this.align(4);
    const lenAt = this.len;
    this._grow(4);
    this.len += 4;
    this.align(ALIGN[elem.t]);   // padding after the length is not counted in it
    const start = this.len;
    if (elem.t === 'y' && (Buffer.isBuffer(v) || v instanceof Uint8Array)) {
      this.bytes(Buffer.from(v));
    } else if (elem.t === '{') {
      const entries = v instanceof Map ? [...v] : Array.isArray(v) ? v : Object.entries(v);
      for (const e of entries) {
        this.align(8);
        this.write(elem.key, e[0], depth + 1);
        this.write(elem.value, e[1], depth + 1);
      }
    } else {
      if (!Array.isArray(v)) throw new DBusError('expected an array');
      for (const item of v) this.write(elem, item, depth + 1);
    }
    const n = this.len - start;
    if (n > MAX_ARRAY) throw new DBusError('array too large');
    this.buf.writeUInt32LE(n, lenAt);
  }
}

/** Marshals values for a signature into a Buffer (aligned from offset 0, which is where a message body starts). */
function marshal(sig, values) {
  const types = parseSignature(sig);
  if (!Array.isArray(values) || values.length !== types.length) throw new DBusError('signature ' + sig + ' needs ' + types.length + ' values');
  const w = new Writer();
  types.forEach((t, i) => w.write(t, values[i]));
  return Buffer.from(w.result());
}

// ---------- reader ----------

class Reader {
  constructor(buf, start, end, le) { this.buf = buf; this.pos = start; this.end = end; this.le = le; this.base = start; }
  _need(n) { if (this.pos + n > this.end) throw new DBusError('message is truncated'); }
  align(n) {
    const pad = (n - ((this.pos - this.base) % n)) % n;
    this._need(pad);
    this.pos += pad;
  }
  _take(size) { this.align(size); this._need(size); const o = this.pos; this.pos += size; return o; }
  u8() { const o = this._take(1); return this.buf[o]; }
  u32() { const o = this._take(4); return this.le ? this.buf.readUInt32LE(o) : this.buf.readUInt32BE(o); }

  read(type, depth = 0) {
    if (depth > MAX_DEPTH) throw new DBusError('value nested too deeply');
    const b = this.buf, le = this.le;
    switch (type.t) {
      case 'y': return this.u8();
      case 'b': { const v = this.u32(); if (v > 1) throw new DBusError('bad boolean'); return v === 1; }
      case 'n': { const o = this._take(2); return le ? b.readInt16LE(o) : b.readInt16BE(o); }
      case 'q': { const o = this._take(2); return le ? b.readUInt16LE(o) : b.readUInt16BE(o); }
      case 'i': { const o = this._take(4); return le ? b.readInt32LE(o) : b.readInt32BE(o); }
      case 'u': return this.u32();
      case 'x': { const o = this._take(8); return le ? b.readBigInt64LE(o) : b.readBigInt64BE(o); }
      case 't': { const o = this._take(8); return le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o); }
      case 'd': { const o = this._take(8); return le ? b.readDoubleLE(o) : b.readDoubleBE(o); }
      case 's': case 'o': {
        const n = this.u32();
        if (n > this.end - this.pos) throw new DBusError('string is longer than the message');
        const s = decodeString(b.subarray(this.pos, this.pos + n));
        this.pos += n;
        this._nul();
        if (type.t === 'o' && !validObjectPath(s)) throw new DBusError('bad object path');
        return s;
      }
      case 'g': {
        const n = this.u8();
        this._need(n);
        const s = decodeString(b.subarray(this.pos, this.pos + n));
        this.pos += n;
        this._nul();
        parseSignature(s);
        return s;
      }
      case 'v': {
        const sig = this.read({ t: 'g' }, depth + 1);
        const types = parseSignature(sig);
        if (types.length !== 1) throw new DBusError('a variant holds exactly one value');
        return new Variant(sig, this.read(types[0], depth + 1));
      }
      case 'a': return this._array(type, depth);
      case '(': {
        this.align(8);
        return type.fields.map((f) => this.read(f, depth + 1));
      }
      default: throw new DBusError('cannot read type ' + type.t);
    }
  }
  _nul() { this._need(1); if (this.buf[this.pos++] !== 0) throw new DBusError('string is not NUL-terminated'); }
  _array(type, depth) {
    const n = this.u32();
    if (n > MAX_ARRAY) throw new DBusError('array too large');
    const elem = type.elem;
    this.align(ALIGN[elem.t]);
    if (n > this.end - this.pos) throw new DBusError('array is longer than the message');
    const stop = this.pos + n;
    if (elem.t === 'y') { const out = Buffer.from(this.buf.subarray(this.pos, stop)); this.pos = stop; return out; }
    const saved = this.end;
    this.end = stop;   // an element may not read past the array's own length
    const items = [];
    while (this.pos < stop) {
      if (elem.t === '{') { this.align(8); items.push([this.read(elem.key, depth + 1), this.read(elem.value, depth + 1)]); }
      else items.push(this.read(elem, depth + 1));
    }
    this.end = saved;
    if (this.pos !== stop) throw new DBusError('array length does not match its contents');
    return elem.t === '{' ? new Map(items) : items;
  }
}

/** Unmarshals a body. `le` is the message's byte order. The whole body must be consumed. */
function unmarshal(sig, buf, le = true) {
  const types = parseSignature(sig);
  const r = new Reader(buf, 0, buf.length, le);
  const out = types.map((t) => r.read(t));
  if (r.pos !== buf.length) throw new DBusError('unexpected bytes after the body');
  return out;
}

// ---------- messages ----------

const TYPE = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 };
const FLAG = { NO_REPLY_EXPECTED: 1, NO_AUTO_START: 2 };
const FIELD = { PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR_NAME: 4, REPLY_SERIAL: 5, DESTINATION: 6, SENDER: 7, SIGNATURE: 8, UNIX_FDS: 9 };
const FIELD_NAMES = Object.fromEntries(Object.entries(FIELD).map(([k, v]) => [v, k.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase())]));
const FIELD_SIG = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g', 9: 'u' };
const HEADER_FIELDS_TYPE = parseSignature('a(yv)')[0];

/**
 * msg: { type, flags?, serial, path?, interface?, member?, errorName?, replySerial?, destination?, sender?, signature?, body? }
 * `body` is an array of values matching `signature`.
 */
function encodeMessage(msg) {
  const sig = msg.signature || '';
  const body = marshal(sig, msg.body || []);
  const fields = [];
  const add = (code, key) => { if (msg[key] !== undefined) fields.push([code, new Variant(FIELD_SIG[code], msg[key])]); };
  add(FIELD.PATH, 'path'); add(FIELD.INTERFACE, 'interface'); add(FIELD.MEMBER, 'member'); add(FIELD.ERROR_NAME, 'errorName');
  add(FIELD.REPLY_SERIAL, 'replySerial'); add(FIELD.DESTINATION, 'destination'); add(FIELD.SENDER, 'sender');
  if (sig) fields.push([FIELD.SIGNATURE, new Variant('g', sig)]);
  const w = new Writer();
  w.u8(0x6c);                      // 'l': little endian
  w.u8(msg.type);
  w.u8(msg.flags || 0);
  w.u8(1);                         // protocol version
  w.u32(body.length);
  w.u32(msg.serial);
  w.write(HEADER_FIELDS_TYPE, fields);
  w.align(8);
  const head = w.result();
  const total = head.length + body.length;
  if (total > MAX_MESSAGE) throw new DBusError('message too large');
  return Buffer.concat([head, body], total);
}

function validateMessage(m) {
  const need = (cond, why) => { if (!cond) throw new DBusError('invalid message: ' + why); };
  need(m.serial !== 0, 'serial is zero');
  switch (m.type) {
    case TYPE.METHOD_CALL:
      need(validObjectPath(m.path), 'method call needs a path');
      need(validMemberName(m.member), 'method call needs a member');
      need(m.interface === undefined || validInterfaceName(m.interface), 'bad interface name');
      break;
    case TYPE.SIGNAL:
      need(validObjectPath(m.path), 'signal needs a path');
      need(validInterfaceName(m.interface), 'signal needs an interface');
      need(validMemberName(m.member), 'signal needs a member');
      break;
    case TYPE.ERROR:
      need(validInterfaceName(m.errorName), 'error needs a name');
      need(m.replySerial !== undefined, 'error needs a reply serial');
      break;
    case TYPE.METHOD_RETURN:
      need(m.replySerial !== undefined, 'reply needs a reply serial');
      break;
    default: break;   // unknown message types are ignored by the spec, not an error
  }
}

/** Decodes one whole message (header + body). Throws DBusError when anything is malformed. */
function decodeMessage(buf) {
  if (buf.length < 16) throw new DBusError('message is shorter than a header');
  const le = buf[0] === 0x6c;
  if (!le && buf[0] !== 0x42) throw new DBusError('bad byte-order marker');
  if (buf[3] !== 1) throw new DBusError('unsupported protocol version ' + buf[3]);
  const bodyLen = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const serial = le ? buf.readUInt32LE(8) : buf.readUInt32BE(8);
  const r = new Reader(buf, 12, buf.length, le);
  r.base = 0;   // alignment is measured from the start of the message
  r.pos = 12;
  const rawFields = r.read(HEADER_FIELDS_TYPE);
  r.align(8);
  const bodyStart = r.pos;
  if (bodyLen > buf.length - bodyStart || bodyStart + bodyLen !== buf.length) throw new DBusError('body length does not match the message');
  const msg = { type: buf[1], flags: buf[2], serial };
  for (const [code, variant] of rawFields) {
    const name = FIELD_NAMES[code];
    if (!name) continue;   // unknown header fields must be ignored
    if (variant.sig !== FIELD_SIG[code]) throw new DBusError('header field ' + name + ' has the wrong type');
    msg[name] = variant.value;
  }
  validateMessage(msg);
  msg.signature = msg.signature || '';
  msg.body = unmarshal(msg.signature, buf.subarray(bodyStart), le);
  return msg;
}

/** Cuts a byte stream into whole messages. feed() returns the messages that are complete; it throws on a bad stream. */
class MessageStream {
  constructor() { this.pending = Buffer.alloc(0); }
  feed(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.pending.length < 16) break;
      const le = this.pending[0] === 0x6c;
      if (!le && this.pending[0] !== 0x42) throw new DBusError('bad byte-order marker');
      const bodyLen = le ? this.pending.readUInt32LE(4) : this.pending.readUInt32BE(4);
      const fieldsLen = le ? this.pending.readUInt32LE(12) : this.pending.readUInt32BE(12);
      if (fieldsLen > MAX_ARRAY) throw new DBusError('header fields too large');
      const headLen = Math.ceil((16 + fieldsLen) / 8) * 8;
      const total = headLen + bodyLen;
      if (total > MAX_MESSAGE) throw new DBusError('message too large');   // refused before it is buffered
      if (this.pending.length < total) break;
      out.push(decodeMessage(this.pending.subarray(0, total)));
      this.pending = this.pending.subarray(total);
    }
    if (!this.pending.length) this.pending = Buffer.alloc(0);
    return out;
  }
}

module.exports = {
  DBusError, Variant, TYPE, FLAG, MAX_MESSAGE,
  parseSignature, typeToString, marshal, unmarshal, encodeMessage, decodeMessage, MessageStream,
  validObjectPath, validInterfaceName, validMemberName, validBusName,
};
