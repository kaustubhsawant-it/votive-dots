'use strict';
//
// The D-Bus wire format (linux/dbus/wire.js). Pure functions, so these run on macOS and in the Linux container alike.
// Byte vectors are worked out by hand from the specification, then values are round-tripped, then hostile input is thrown at it.
//
const { test } = require('node:test');
const assert = require('node:assert');
const w = require('../linux/dbus/wire');

const hex = (b) => b.toString('hex');
const rt = (sig, values) => w.unmarshal(sig, w.marshal(sig, values));

test('basic types match the specification byte for byte', () => {
  assert.equal(hex(w.marshal('s', ['hi'])), '02000000' + '6869' + '00');
  assert.equal(hex(w.marshal('y', [7])), '07');
  assert.equal(hex(w.marshal('yu', [1, 2])), '01000000' + '02000000');           // u aligns to 4
  assert.equal(hex(w.marshal('b', [true])), '01000000');
  assert.equal(hex(w.marshal('n', [-2])), 'feff');
  assert.equal(hex(w.marshal('x', [-1n])), 'ffffffffffffffff');
  assert.equal(hex(w.marshal('yd', [1, 1.5])), '01' + '00000000000000' + '000000000000f83f');   // d aligns to 8
  assert.equal(hex(w.marshal('g', ['a{sv}'])), '05' + Buffer.from('a{sv}').toString('hex') + '00');
  assert.equal(hex(w.marshal('o', ['/a/b'])), '04000000' + Buffer.from('/a/b').toString('hex') + '00');
});

test('arrays, structs, dict entries and variants', () => {
  assert.equal(hex(w.marshal('ai', [[1, 2]])), '08000000' + '01000000' + '02000000');
  assert.equal(hex(w.marshal('ay', [Buffer.from([1, 2, 3])])), '03000000010203');
  assert.equal(hex(w.marshal('(yu)', [[1, 2]])), '01000000' + '02000000');
  // an empty array of 8-aligned elements still pads after its length
  assert.equal(hex(w.marshal('a(ii)', [[]])), '00000000' + '00000000');
  // variant: signature "u" (01 75 00), one pad byte to reach 4, then the value
  assert.equal(hex(w.marshal('v', [new w.Variant('u', 9)])), '017500' + '00' + '09000000');
  // a{sv}: length 16, 4 pad bytes (entries align to 8), key "k", variant "b" (01 62 00), 3 pad bytes, true
  assert.equal(hex(w.marshal('a{sv}', [new Map([['k', new w.Variant('b', true)]])])),
    '10000000' + '00000000' + '01000000' + '6b00' + '016200' + '000000' + '01000000');
});

test('round trips, including the shapes a tray sends', () => {
  assert.deepEqual(rt('s', ['héllo ☃']), ['héllo ☃']);
  assert.deepEqual(rt('xt', [-5n, 2n ** 63n]), [-5n, 2n ** 63n]);
  assert.deepEqual(rt('a(iiay)', [[[22, 22, Buffer.from([255, 0, 0, 255])], [24, 24, Buffer.alloc(0)]]]),
    [[[22, 22, Buffer.from([255, 0, 0, 255])], [24, 24, Buffer.alloc(0)]]]);
  const tooltip = ['', [], 'Votive', '2 sessions'];
  assert.deepEqual(rt('(sa(iiay)ss)', [tooltip]), [tooltip]);
  const props = new Map([['a', new w.Variant('s', 'x')], ['b', new w.Variant('as', ['p', 'q'])], ['c', new w.Variant('(iv)', [3, new w.Variant('d', 0.5)])]]);
  assert.deepEqual(rt('a{sv}', [props]), [props]);
  assert.deepEqual(rt('a{sv}', [{ a: new w.Variant('i', 1) }]), [new Map([['a', new w.Variant('i', 1)]])]);   // a plain object is accepted when writing
  assert.deepEqual(rt('ia{ss}s', [1, new Map(), 'z']), [1, new Map(), 'z']);
  assert.deepEqual(rt('i(ia(s))', [4, [5, [['a'], ['b']]]]), [4, [5, [['a'], ['b']]]]);
});

test('big-endian input is read correctly', () => {
  const body = Buffer.from('0000000200000003', 'hex');   // 2, 3 as big-endian u32
  assert.deepEqual(w.unmarshal('uu', body, false), [2, 3]);
});

test('signatures: valid and invalid', () => {
  assert.equal(w.parseSignature('a{sv}').length, 1);
  assert.equal(w.parseSignature('sa(iiay)ss').length, 4);
  assert.equal(w.typeToString(w.parseSignature('(sa(iiay)ss)')[0]), '(sa(iiay)ss)');
  for (const bad of ['(', '()', '(i', 'a', '{sv}', 'a{vs}', 'a{s}', 'a{svv}', '(i{sv})', 'z', 'i)', 'a{sv', 'x'.repeat(300), '('.repeat(40) + 'i' + ')'.repeat(40), 'a'.repeat(40) + 'i']) {
    assert.throws(() => w.parseSignature(bad), w.DBusError, bad.slice(0, 20));
  }
});

test('writing rejects values that do not fit the signature', () => {
  assert.throws(() => w.marshal('y', [256]), /out of range/);
  assert.throws(() => w.marshal('u', [-1]), /out of range/);
  assert.throws(() => w.marshal('i', [1.5]), /out of range/);
  assert.throws(() => w.marshal('s', ['a\0b']), /NUL/);
  assert.throws(() => w.marshal('o', ['not a path']), /object path/);
  assert.throws(() => w.marshal('s', [5]), /string/);
  assert.throws(() => w.marshal('(ii)', [[1]]), /2 fields/);
  assert.throws(() => w.marshal('ss', ['a']), /needs 2 values/);
  assert.throws(() => w.marshal('v', ['plain']), /Variant/);
});

test('reading refuses hostile bodies', () => {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  assert.throws(() => w.unmarshal('s', Buffer.concat([u32(1000), Buffer.from('ab\0')])), /longer than the message/);   // a length that lies
  assert.throws(() => w.unmarshal('s', Buffer.concat([u32(2), Buffer.from('ab!')])), /NUL-terminated/);
  assert.throws(() => w.unmarshal('s', Buffer.concat([u32(3), Buffer.from('a\0b\0')])), /NUL/);                        // embedded NUL
  assert.throws(() => w.unmarshal('s', Buffer.concat([u32(2), Buffer.from([0xc3, 0x28, 0])])), /UTF-8/);             // invalid UTF-8
  assert.throws(() => w.unmarshal('b', u32(2)), /boolean/);
  assert.throws(() => w.unmarshal('ai', Buffer.concat([u32(0xffffffff)])), /too large/);
  assert.throws(() => w.unmarshal('ai', Buffer.concat([u32(8), u32(1)])), /longer than the message/);
  assert.throws(() => w.unmarshal('ai', Buffer.concat([u32(6), u32(1), Buffer.from([1, 0])])), /array length|truncated/);   // an element that straddles the end
  assert.throws(() => w.unmarshal('u', Buffer.from([1, 2])), /truncated/);
  assert.throws(() => w.unmarshal('u', Buffer.from([1, 0, 0, 0, 9])), /unexpected bytes/);
  assert.throws(() => w.unmarshal('o', Buffer.concat([u32(3), Buffer.from('a/b\0')])), /object path/);
  // a variant whose signature holds two values
  assert.throws(() => w.unmarshal('v', Buffer.from([2, 0x69, 0x69, 0, 1, 0, 0, 0, 2, 0, 0, 0])), /exactly one/);
  // a variant nested deeper than the limit
  let deep = Buffer.alloc(0);
  for (let i = 0; i < 60; i++) deep = Buffer.concat([Buffer.from([1, 0x76, 0]), deep]);
  assert.throws(() => w.unmarshal('v', deep), w.DBusError);
});

const call = (over) => Object.assign({ type: w.TYPE.METHOD_CALL, serial: 1, path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'Hello', destination: 'org.freedesktop.DBus' }, over);

test('a message round-trips with its header fields and body', () => {
  const m = call({ member: 'RequestName', signature: 'su', body: ['dev.votive', 4], serial: 7, flags: w.FLAG.NO_AUTO_START });
  const back = w.decodeMessage(w.encodeMessage(m));
  assert.equal(back.type, w.TYPE.METHOD_CALL);
  assert.equal(back.serial, 7);
  assert.equal(back.flags, w.FLAG.NO_AUTO_START);
  for (const k of ['path', 'interface', 'member', 'destination', 'signature']) assert.equal(back[k], m[k], k);
  assert.deepEqual(back.body, ['dev.votive', 4]);
});

test('the encoded Hello message has the exact bytes the daemon expects', () => {
  const b = w.encodeMessage(call());
  assert.equal(b[0], 0x6c); assert.equal(b[1], 1); assert.equal(b[2], 0); assert.equal(b[3], 1);
  assert.equal(b.readUInt32LE(4), 0);          // empty body
  assert.equal(b.readUInt32LE(8), 1);          // serial
  assert.equal(b.length % 8, 0);               // the header is padded to 8
  assert.equal(b.readUInt32LE(12), b.length - 16 - ((8 - ((16 + b.readUInt32LE(12)) % 8)) % 8));   // field array length excludes the padding
});

test('replies, errors and signals decode and are validated', () => {
  const ret = w.decodeMessage(w.encodeMessage({ type: w.TYPE.METHOD_RETURN, serial: 2, replySerial: 1, destination: ':1.5', signature: 's', body: [':1.9'] }));
  assert.equal(ret.replySerial, 1);
  assert.deepEqual(ret.body, [':1.9']);
  const err = w.decodeMessage(w.encodeMessage({ type: w.TYPE.ERROR, serial: 3, replySerial: 1, errorName: 'org.freedesktop.DBus.Error.UnknownMethod', signature: 's', body: ['no'] }));
  assert.equal(err.errorName, 'org.freedesktop.DBus.Error.UnknownMethod');
  const sig = w.decodeMessage(w.encodeMessage({ type: w.TYPE.SIGNAL, serial: 4, path: '/StatusNotifierItem', interface: 'org.kde.StatusNotifierItem', member: 'NewIcon' }));
  assert.equal(sig.member, 'NewIcon');
  assert.throws(() => w.decodeMessage(w.encodeMessage(call({ serial: 0 }))), /serial/);
  assert.throws(() => w.decodeMessage(w.encodeMessage({ type: w.TYPE.SIGNAL, serial: 1, path: '/x', member: 'M' })), /interface/);
  assert.throws(() => w.encodeMessage(call({ path: 'bad' })) && w.decodeMessage(w.encodeMessage(call({ path: 'bad' }))), w.DBusError);
  assert.throws(() => w.decodeMessage(w.encodeMessage({ type: w.TYPE.METHOD_RETURN, serial: 5 })), /reply serial/);
});

test('a header field with the wrong type, a bad body length and a bad version are refused', () => {
  const good = w.encodeMessage(call({ signature: 's', body: ['x'] }));
  const badLen = Buffer.from(good); badLen.writeUInt32LE(99, 4);
  assert.throws(() => w.decodeMessage(badLen), /body length/);
  const badVer = Buffer.from(good); badVer[3] = 2;
  assert.throws(() => w.decodeMessage(badVer), /version/);
  const badEndian = Buffer.from(good); badEndian[0] = 0x00;
  assert.throws(() => w.decodeMessage(badEndian), /byte-order/);
  assert.throws(() => w.decodeMessage(good.subarray(0, 10)), /shorter than a header/);
  assert.throws(() => w.decodeMessage(good.subarray(0, good.length - 1)), w.DBusError);   // truncated body
});

test('the stream splits whole messages from any chunking and refuses oversize ones before buffering', () => {
  const a = w.encodeMessage(call({ serial: 1 }));
  const b = w.encodeMessage(call({ serial: 2, member: 'RequestName', signature: 'su', body: ['dev.votive', 4] }));
  const all = Buffer.concat([a, b]);
  for (const step of [1, 3, 7, 16, all.length]) {
    const s = new w.MessageStream();
    const got = [];
    for (let i = 0; i < all.length; i += step) got.push(...s.feed(all.subarray(i, i + step)));
    assert.deepEqual(got.map((m) => m.serial), [1, 2], 'chunk size ' + step);
  }
  // a header that promises more than the limit is refused as soon as the header is in, without waiting for the body
  const huge = Buffer.from(a); huge.writeUInt32LE(w.MAX_MESSAGE + 1, 4);
  assert.throws(() => new w.MessageStream().feed(huge.subarray(0, 16)), /too large/);
  assert.throws(() => new w.MessageStream().feed(Buffer.from('this is not dbus!!')), /byte-order/);
});

test('name validation', () => {
  assert.ok(w.validObjectPath('/') && w.validObjectPath('/org/kde/StatusNotifierItem') && w.validObjectPath('/a_b/C1'));
  for (const bad of ['', 'a', '//', '/a/', '/a//b', '/a-b', '/1/', '/a b']) assert.ok(!w.validObjectPath(bad), bad);
  assert.ok(w.validInterfaceName('org.kde.StatusNotifierItem') && !w.validInterfaceName('nodots') && !w.validInterfaceName('a..b') && !w.validInterfaceName('a.1b'));
  assert.ok(w.validMemberName('GetLayout') && !w.validMemberName('') && !w.validMemberName('a.b') && !w.validMemberName('1a'));
  assert.ok(w.validBusName(':1.42') && w.validBusName('org.freedesktop.Notifications') && w.validBusName('org.kde.StatusNotifierItem-123-1') && !w.validBusName('nodots'));
});
