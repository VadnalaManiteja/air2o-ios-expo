const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let NativeVoiceController;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/nativeVoiceController.js'), 'utf8');
  ({ NativeVoiceController } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
});
function fixture(onDevice = true) {
  const listeners = {};
  const events = [], starts = [];
  const recognizer = {
    addListener: (name, callback) => { listeners[name] = callback; return { remove() {} }; },
    requestPermissionsAsync: async () => ({ granted: true }),
    isRecognitionAvailable: () => true,
    start: options => starts.push(options),
    stop: () => {}, abort: () => {}, setCategoryIOS: () => {},
  };
  const controller = new NativeVoiceController(recognizer, event => events.push(event), () => onDevice);
  return { controller, recognizer, events, starts, emit: (name, event = {}) => listeners[name](event) };
}
const start = (requestId, mode = 'conversation') => ({ action: 'start', requestId, mode, lang: 'hi-IN' });

test('conversation uses requested locale and forwards request-scoped results', async () => {
  const f = fixture();
  await f.controller.handle(start('one'));
  f.emit('result', { isFinal: true, results: [{ transcript: 'hello' }] });
  assert.equal(f.starts[0].lang, 'hi-IN');
  assert.equal(f.events[0].requestId, 'one');
  f.controller.dispose();
});
test('handoff waits for microphone end and discards cancelled results', async () => {
  const f = fixture();
  await f.controller.handle(start('wake', 'wake'));
  const next = f.controller.handle(start('dictation', 'dictation'));
  await Promise.resolve();
  assert.equal(f.starts.length, 1);
  f.emit('result', { results: [{ transcript: 'stale' }] });
  assert.equal(f.events.length, 0);
  f.emit('end');
  await next;
  assert.equal(f.starts.length, 2);
  f.emit('result', { results: [{ transcript: 'new' }] });
  assert.equal(f.events[0].requestId, 'dictation');
  f.controller.dispose();
});
test('wake phrase refuses unsupported on-device locale without starting capture', async () => {
  const f = fixture(false);
  await f.controller.handle(start('wake', 'wake'));
  assert.equal(f.starts.length, 0);
  assert.match(f.events[0].message, /On-device/);
  assert.equal(f.events[1].event, 'end');
  f.controller.dispose();
});
test('wake phrase explicitly requires on-device English recognition', async () => {
  const f = fixture();
  await f.controller.handle(start('wake', 'wake'));
  assert.equal(f.starts[0].requiresOnDeviceRecognition, true);
  assert.equal(f.starts[0].lang, 'en-US');
  f.controller.dispose();
});
test('permission denial returns actionable error and end', async () => {
  const f = fixture();
  f.recognizer.requestPermissionsAsync = async () => ({ granted: false });
  await f.controller.handle(start('one'));
  assert.equal(f.starts.length, 0);
  assert.match(f.events[0].message, /Settings/);
  assert.equal(f.events[1].event, 'end');
  f.controller.dispose();
});
test('cancel during permission request never starts capture later', async () => {
  const f = fixture();
  let grant;
  f.recognizer.requestPermissionsAsync = () => new Promise(resolve => { grant = resolve; });
  const pending = f.controller.handle(start('one'));
  await Promise.resolve();
  await f.controller.handle({ action: 'cancel', requestId: 'one' });
  grant({ granted: true });
  await pending;
  assert.equal(f.starts.length, 0);
  f.controller.dispose();
});
test('background stops capture and invalidates pending start', async () => {
  const f = fixture();
  await f.controller.handle(start('one'));
  f.controller.setForeground(false);
  assert.equal(f.events[0].event, 'interrupted');
  f.emit('end');
  await f.controller.handle(start('two'));
  assert.equal(f.starts.length, 1);
  f.controller.dispose();
});
test('latest queued start wins after old capture ends', async () => {
  const f = fixture();
  await f.controller.handle(start('one'));
  const second = f.controller.handle(start('two'));
  const third = f.controller.handle(start('three'));
  f.emit('end');
  await Promise.all([second, third]);
  assert.equal(f.starts.length, 2);
  f.emit('start');
  assert.equal(f.events.at(-1).requestId, 'three');
  f.controller.dispose();
});

test('a stop while permissions are pending ends the request without later capture', async () => {
  const f = fixture();
  let grant;
  f.recognizer.requestPermissionsAsync = () => new Promise(resolve => { grant = resolve; });
  const pending = f.controller.handle(start('one'));
  await Promise.resolve();
  assert.equal(f.controller.requestingPermission, true);
  await f.controller.handle({ action: 'stop', requestId: 'one' });
  grant({ granted: true });
  await pending;
  assert.equal(f.starts.length, 0);
  assert.equal(f.events[0].event, 'end');
  f.controller.dispose();
});

test('an obsolete cancel does not invalidate a newer permission request', async () => {
  const f = fixture();
  let grant;
  f.recognizer.requestPermissionsAsync = () => new Promise(resolve => { grant = resolve; });
  const pending = f.controller.handle(start('new'));
  await Promise.resolve();
  await f.controller.handle({ action: 'cancel', requestId: 'old' });
  grant({ granted: true });
  await pending;
  assert.equal(f.starts.length, 1);
  f.controller.dispose();
});

test('permission-sheet inactivity preserves the initiating tap', async () => {
  const f = fixture();
  let grant;
  f.recognizer.requestPermissionsAsync = () => new Promise(resolve => { grant = resolve; });
  const pending = f.controller.handle(start('one'));
  await Promise.resolve();
  assert.equal(f.controller.setAppState('inactive'), false);
  f.controller.setAppState('active');
  grant({ granted: true });
  await pending;
  assert.equal(f.starts.length, 1);
  f.controller.dispose();
});

test('real backgrounding cancels even while a permission sheet is pending', async () => {
  const f = fixture();
  let grant;
  f.recognizer.requestPermissionsAsync = () => new Promise(resolve => { grant = resolve; });
  const pending = f.controller.handle(start('one'));
  await Promise.resolve();
  f.controller.setAppState('background');
  f.controller.setAppState('active');
  grant({ granted: true });
  await pending;
  assert.equal(f.starts.length, 0);
  f.controller.dispose();
});
