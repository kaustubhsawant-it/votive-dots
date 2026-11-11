'use strict';
//
// A small D-Bus client over a unix socket: connect, authenticate (EXTERNAL), Hello, method calls, signals, and
// exporting objects (methods, properties, signals) with Introspect and org.freedesktop.DBus.Properties filled in.
//
// The only module it loads besides wire.js is Node's `net` (a unix socket, never TCP). tests/linux-source.test.js
// checks that. The peer is untrusted: a malformed message closes the connection instead of being half-handled.
//
const net = require('net');
const { EventEmitter } = require('events');
const wire = require('./wire');

const { DBusError, Variant, TYPE, FLAG } = wire;
const MAX_LINE = 4096;          // the auth handshake is a few short lines
const MAX_PENDING = 256;        // calls waiting for a reply
const CALL_TIMEOUT_MS = 10000;

const E = {
  UnknownMethod: 'org.freedesktop.DBus.Error.UnknownMethod',
  UnknownObject: 'org.freedesktop.DBus.Error.UnknownObject',
  UnknownInterface: 'org.freedesktop.DBus.Error.UnknownInterface',
  UnknownProperty: 'org.freedesktop.DBus.Error.UnknownProperty',
  PropertyReadOnly: 'org.freedesktop.DBus.Error.PropertyReadOnly',
  InvalidArgs: 'org.freedesktop.DBus.Error.InvalidArgs',
  Failed: 'org.freedesktop.DBus.Error.Failed',
};

/** "unix:path=/run/user/1000/bus,guid=..." (or several, separated by ;) to the socket path to connect to. */
function parseAddress(address) {
  if (typeof address !== 'string' || !address) throw new DBusError('no D-Bus address (is DBUS_SESSION_BUS_ADDRESS set?)');
  const unescape = (s) => s.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  for (const entry of address.split(';')) {
    const m = /^unix:(.*)$/.exec(entry.trim());
    if (!m) continue;
    const opts = Object.fromEntries(m[1].split(',').filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return i < 0 ? [kv, ''] : [kv.slice(0, i), unescape(kv.slice(i + 1))];
    }));
    if (opts.path) return opts.path;
    if (opts.abstract) return '\0' + opts.abstract;   // Node connects to a Linux abstract socket when the path starts with NUL
  }
  throw new DBusError('only unix: D-Bus addresses are supported');
}

function sessionAddress(env = process.env) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env.DBUS_SESSION_BUS_ADDRESS;
  if (env.XDG_RUNTIME_DIR) return 'unix:path=' + env.XDG_RUNTIME_DIR + '/bus';
  throw new DBusError('no session bus: DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR are both unset');
}

class Connection extends EventEmitter {
  constructor(address = sessionAddress()) {
    super();
    this.socketPath = parseAddress(address);
    this.serial = 0;
    this.pending = new Map();      // serial -> { resolve, reject, timer }
    this.objects = new Map();      // path -> { interfaces }
    this.uniqueName = null;
    this.closed = false;
    this._stream = new wire.MessageStream();
  }

  async connect() {
    this.socket = net.createConnection(this.socketPath);
    this.socket.on('error', (e) => this._close(e));
    this.socket.on('close', () => this._close());
    await new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject); });
    const rest = await this._authenticate();
    this.socket.on('data', (d) => this._onData(d));
    if (rest.length) this._onData(rest);
    const [name] = await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'Hello' });
    this.uniqueName = name;
    return this;
  }

  _authenticate() {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const uidHex = Buffer.from(String(process.getuid())).toString('hex');
      const fail = (e) => { this.socket.off('data', onData); reject(e); };
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n');
        if (end < 0) { if (buf.length > MAX_LINE) fail(new DBusError('auth reply too long')); return; }
        const line = buf.subarray(0, end).toString('latin1');
        if (!line.startsWith('OK ')) return fail(new DBusError('the bus refused authentication: ' + line.slice(0, 80)));
        this.socket.off('data', onData);
        this.socket.write('BEGIN\r\n');
        resolve(buf.subarray(end + 2));
      };
      this.socket.on('data', onData);
      this.socket.write('\0AUTH EXTERNAL ' + uidHex + '\r\n');
    });
  }

  _onData(chunk) {
    let messages;
    try { messages = this._stream.feed(chunk); } catch (e) { this._close(e); return; }
    for (const m of messages) {
      try { this._dispatch(m); } catch (e) { this.emit('warning', e); }
    }
  }

  _dispatch(m) {
    switch (m.type) {
      case TYPE.METHOD_RETURN:
      case TYPE.ERROR: {
        const p = this.pending.get(m.replySerial);
        if (!p) return;   // a reply to nothing we asked, or one that timed out
        this.pending.delete(m.replySerial);
        clearTimeout(p.timer);
        if (m.type === TYPE.ERROR) p.reject(new DBusError((m.body && typeof m.body[0] === 'string' && m.body[0]) || m.errorName, m.errorName));
        else p.resolve(m.body);
        return;
      }
      case TYPE.SIGNAL: this.emit('signal', m); this.emit('signal:' + m.interface + '.' + m.member, m); return;
      case TYPE.METHOD_CALL: this._onCall(m); return;
      default: return;
    }
  }

  _send(msg) {
    if (this.closed) throw new DBusError('the connection is closed');
    this.socket.write(wire.encodeMessage(msg));
  }

  /** { destination, path, interface, member, signature?, body? } -> Promise of the reply body (an array). */
  call(spec, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new DBusError('the connection is closed'));
      if (this.pending.size >= MAX_PENDING) return reject(new DBusError('too many calls in flight'));
      const serial = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(serial); reject(new DBusError('no reply to ' + spec.member + ' in ' + timeoutMs + ' ms', 'org.freedesktop.DBus.Error.Timeout')); }, timeoutMs);
      timer.unref();
      this.pending.set(serial, { resolve, reject, timer });
      try { this._send(Object.assign({ type: TYPE.METHOD_CALL, serial }, spec)); } catch (e) { this.pending.delete(serial); clearTimeout(timer); reject(e); }
    });
  }

  /** Fire-and-forget method call (no reply is asked for). */
  callNoReply(spec) { this._send(Object.assign({ type: TYPE.METHOD_CALL, serial: ++this.serial, flags: FLAG.NO_REPLY_EXPECTED }, spec)); }

  emitSignal(path, iface, member, signature = '', body = []) {
    this._send({ type: TYPE.SIGNAL, serial: ++this.serial, path, interface: iface, member, signature, body });
  }

  async requestName(name, flags = 4 /* DO_NOT_QUEUE */) {
    const [code] = await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'RequestName', signature: 'su', body: [name, flags] });
    return code === 1 || code === 4;   // PRIMARY_OWNER or ALREADY_OWNER
  }

  addMatch(rule) {
    return this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] });
  }

  // ---------- exporting objects ----------
  //
  // exportObject('/StatusNotifierItem', {
  //   'org.kde.StatusNotifierItem': {
  //     methods:    { Activate: { in: 'ii', out: '', fn: (x, y) => [] } },       // fn returns an array of out values (or a promise of one)
  //     properties: { Title: { sig: 's', get: () => 'Votive' } },                   // add `set: (v) => {}` to make it writable
  //     signals:    { NewIcon: '' },                                                // name -> signature, for introspection
  //   },
  // })
  exportObject(path, interfaces) {
    if (!wire.validObjectPath(path)) throw new DBusError('bad object path');
    for (const name of Object.keys(interfaces)) {
      if (!wire.validInterfaceName(name)) throw new DBusError('bad interface name ' + name);
      const def = interfaces[name];
      for (const m of Object.keys(def.methods || {})) { wire.parseSignature(def.methods[m].in || ''); wire.parseSignature(def.methods[m].out || ''); }
      for (const p of Object.keys(def.properties || {})) wire.parseSignature(def.properties[p].sig);
    }
    this.objects.set(path, interfaces);
  }

  unexportObject(path) { this.objects.delete(path); }

  emitPropertiesChanged(path, iface, changedNames) {
    const def = (this.objects.get(path) || {})[iface];
    if (!def) return;
    const changed = new Map(changedNames.map((n) => [n, new Variant(def.properties[n].sig, def.properties[n].get())]));
    this.emitSignal(path, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', 'sa{sv}as', [iface, changed, []]);
  }

  _reply(call, signature, body) {
    if (call.flags & FLAG.NO_REPLY_EXPECTED) return;
    this._send({ type: TYPE.METHOD_RETURN, serial: ++this.serial, replySerial: call.serial, destination: call.sender, signature, body });
  }

  _replyError(call, name, text) {
    if (call.flags & FLAG.NO_REPLY_EXPECTED) return;
    this._send({ type: TYPE.ERROR, serial: ++this.serial, replySerial: call.serial, destination: call.sender, errorName: wire.validInterfaceName(name) ? name : E.Failed, signature: 's', body: [String(text).slice(0, 200)] });
  }

  _childNames(path) {
    const prefix = path === '/' ? '/' : path + '/';
    const kids = new Set();
    for (const p of this.objects.keys()) if (p !== path && p.startsWith(prefix)) kids.add(p.slice(prefix.length).split('/')[0]);
    return [...kids];
  }

  _introspect(path) {
    const ifaces = this.objects.get(path) || {};
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const args = (sig, dir) => wire.parseSignature(sig).map((t) => '<arg type="' + esc(wire.typeToString(t)) + '"' + (dir ? ' direction="' + dir + '"' : '') + '/>').join('');
    let xml = '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">\n<node>\n';
    xml += ' <interface name="org.freedesktop.DBus.Introspectable"><method name="Introspect"><arg type="s" direction="out"/></method></interface>\n';
    xml += ' <interface name="org.freedesktop.DBus.Properties"><method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>' +
      '<method name="GetAll"><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method><method name="Set"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/></method>' +
      '<signal name="PropertiesChanged"><arg type="s"/><arg type="a{sv}"/><arg type="as"/></signal></interface>\n';
    for (const [name, def] of Object.entries(ifaces)) {
      xml += ' <interface name="' + esc(name) + '">\n';
      for (const [m, d] of Object.entries(def.methods || {})) xml += '  <method name="' + esc(m) + '">' + args(d.in || '', 'in') + args(d.out || '', 'out') + '</method>\n';
      for (const [s, sig] of Object.entries(def.signals || {})) xml += '  <signal name="' + esc(s) + '">' + args(sig) + '</signal>\n';
      for (const [p, d] of Object.entries(def.properties || {})) xml += '  <property name="' + esc(p) + '" type="' + esc(d.sig) + '" access="' + (d.set ? 'readwrite' : 'read') + '"/>\n';
      xml += ' </interface>\n';
    }
    for (const kid of this._childNames(path)) xml += ' <node name="' + esc(kid) + '"/>\n';
    return xml + '</node>\n';
  }

  async _onCall(m) {
    try {
      const obj = this.objects.get(m.path);
      if (m.interface === 'org.freedesktop.DBus.Introspectable' && m.member === 'Introspect') {
        if (!obj && !this._childNames(m.path).length) throw new DBusError('no object at ' + m.path, E.UnknownObject);
        return this._reply(m, 's', [this._introspect(m.path)]);
      }
      if (!obj) throw new DBusError('no object at ' + m.path, E.UnknownObject);
      if (m.interface === 'org.freedesktop.DBus.Properties') return this._onProperties(m, obj);
      const names = m.interface ? [m.interface] : Object.keys(obj);
      for (const n of names) {
        const spec = obj[n] && obj[n].methods && obj[n].methods[m.member];
        if (!spec) continue;
        if (m.signature !== (spec.in || '')) throw new DBusError(m.member + ' takes (' + (spec.in || '') + ')', E.InvalidArgs);
        const out = (await spec.fn(...m.body)) || [];
        return this._reply(m, spec.out || '', out);
      }
      throw new DBusError('no method ' + m.member, obj[m.interface] || !m.interface ? E.UnknownMethod : E.UnknownInterface);
    } catch (e) {
      // the connection may be gone by now (a handler that quits); there is nobody left to tell
      try { this._replyError(m, e.dbusName || E.Failed, e.message); } catch (e2) { /* closed */ }
    }
  }

  _onProperties(m, obj) {
    const prop = (iface, name) => {
      const def = obj[iface];
      if (!def) throw new DBusError('no interface ' + iface, E.UnknownInterface);
      const p = (def.properties || {})[name];
      if (!p) throw new DBusError('no property ' + name, E.UnknownProperty);
      return p;
    };
    if (m.member === 'Get' && m.signature === 'ss') {
      const p = prop(m.body[0], m.body[1]);
      return this._reply(m, 'v', [new Variant(p.sig, p.get())]);
    }
    if (m.member === 'GetAll' && m.signature === 's') {
      const def = obj[m.body[0]];
      if (!def) throw new DBusError('no interface ' + m.body[0], E.UnknownInterface);
      const all = new Map(Object.entries(def.properties || {}).map(([n, p]) => [n, new Variant(p.sig, p.get())]));
      return this._reply(m, 'a{sv}', [all]);
    }
    if (m.member === 'Set' && m.signature === 'ssv') {
      const p = prop(m.body[0], m.body[1]);
      if (!p.set) throw new DBusError(m.body[1] + ' is read-only', E.PropertyReadOnly);
      if (m.body[2].sig !== p.sig) throw new DBusError('wrong type for ' + m.body[1], E.InvalidArgs);
      p.set(m.body[2].value);
      return this._reply(m, '', []);
    }
    throw new DBusError('no method ' + m.member, E.UnknownMethod);
  }

  _close(err) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err || new DBusError('the connection closed')); }
    this.pending.clear();
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
    this.emit('close', err);
  }

  close() { this._close(); }
}

module.exports = { Connection, parseAddress, sessionAddress, E };
