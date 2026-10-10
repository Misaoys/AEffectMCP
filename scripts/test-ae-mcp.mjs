import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOOLS, hostWrapper, callTool, cdpEvaluate } from './ae-mcp.mjs';

const serverPath = fileURLToPath(new URL('./ae-mcp.mjs', import.meta.url));
const work = path.resolve(process.env.AE_MCP_TEST_WORK || path.join(process.cwd(), 'work', 'ae-mcp', 'tests'));
await fs.mkdir(work, { recursive: true });
function fakeHost(extra = {}) {
  return vm.createContext({ app: { version: '25.fixture', name: 'Adobe After Effects', project: {} }, CompItem: function CompItem() {}, JSON: undefined, ...extra });
}
test('ES3 wrapper preserves Unicode, control characters, quotes and nested JSON without host JSON', () => {
  const code = 'return {text:"中文\\n\\t\\\"\\\\",nested:[1,true,null,{zero:0}],u:"\\u2028",nan:NaN};';
  const actual = JSON.parse(vm.runInContext(hostWrapper({ runId: 'fixture', code }), fakeHost()));
  assert.equal(actual.success, true); assert.equal(actual.stage, 'complete'); assert.equal(actual.aeVersion, '25.fixture');
  assert.deepEqual(actual.data, { text: '中文\n\t"\\', nested: [1, true, null, { zero: 0 }], u: '\u2028', nan: null });
});
test('host exception is structured and closes an opened undo group', () => {
  let began = 0, ended = 0;
  const context = fakeHost(); context.app.beginUndoGroup = () => began++; context.app.endUndoGroup = () => ended++;
  const actual = JSON.parse(vm.runInContext(hostWrapper({ runId: 'failure', code: 'throw new Error("assertion failed");', undoGroup: 'fixture' }), context));
  assert.equal(actual.success, false); assert.equal(actual.stage, 'failed'); assert.match(actual.errors[0].message, /assertion failed/);
  assert.equal(began, 1); assert.equal(ended, 1);
});
test('wrong host cannot execute user code', () => {
  let called = false;
  const result = JSON.parse(vm.runInContext(hostWrapper({ runId: 'wrong', code: 'danger(); return true;' }), vm.createContext({ app: { version: 'other' }, danger() { called = true; } })));
  assert.equal(called, false); assert.equal(result.success, false); assert.match(result.errors[0].message, /not After Effects/);
});
test('isolated wrapper requests exit only for a fresh empty helper project', () => {
  const context = fakeHost(); context.app.project.numItems = 0;
  const actual = JSON.parse(vm.runInContext(hostWrapper({ runId: 'owned', code: 'return {check:true};', isolated: true }), context));
  assert.equal(actual.success, true); assert.equal(context.app.exitAfterLaunchAndEval, true);
  const changed = fakeHost(); changed.app.project.numItems = 2;
  const refused = JSON.parse(vm.runInContext(hostWrapper({ runId: 'changed', code: 'throw new Error("must not run");', isolated: true }), changed));
  assert.equal(refused.success, false); assert.match(refused.errors[0].message, /empty project/); assert.equal(changed.app.exitAfterLaunchAndEval, undefined);
});
test('result file records current run, progress and final host outcome', () => {
  const writes = [], context = fakeHost({ File: function File() { this.open = () => true; this.write = s => { writes.push(JSON.parse(s)); return true; }; this.close = () => {}; } });
  const result = JSON.parse(vm.runInContext(hostWrapper({ runId: 'fresh', code: 'return {check:true};', resultPath: 'fixture.json' }), context));
  assert.deepEqual(writes.map(x => x.stage), ['starting', 'executing', 'complete']); assert.equal(result.runId, 'fresh'); assert.equal(writes[2].success, true);
});
test('missing result file permission is not a successful mutation', () => {
  let called = false;
  const context = fakeHost({ mutation() { called = true; }, File: function File() { this.error = 'denied'; this.open = () => false; } });
  const result = JSON.parse(vm.runInContext(hostWrapper({ runId: 'denied', code: 'mutation();', resultPath: 'fixture.json' }), context));
  assert.equal(called, false); assert.equal(result.success, false); assert.match(result.errors[0].message, /open failed/);
});
test('JSX input validation refuses ambiguous scripts and unrelated executable names', async () => {
  await assert.rejects(callTool('ae_execute_jsx', { code: 'return 1', scriptPath: serverPath }), /exactly one/);
  await assert.rejects(callTool('ae_execute_jsx', { code: 'return 1', afterfxPath: process.execPath }), /Unexpected executable|Windows/);
  await assert.rejects(callTool('ae_cep_targets', { port: 65535 }), /Invalid argument/);
  await assert.rejects(callTool('ae_cep_targets', { port: 9000, url: 'https://remote.invalid' }), /Unknown argument/);
  await assert.rejects(callTool('ae_execute_jsx', { transport: 'cdp', launchMode: 'isolated', code: 'return 1;' }), /requires CLI/);
});
test('stdio negotiates protocol, lists tools and returns tool failures as isError', async () => {
  const requests = [
    { id: 0, method: 'tools/list' },
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'ae_execute_jsx', arguments: { code: 'return 1', scriptPath: serverPath } } },
    { id: 4, method: 'ping' }
  ];
  const child = spawn(process.execPath, [serverPath, '--stdio'], { windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  child.stdin.end(requests.map(x => JSON.stringify({ jsonrpc: '2.0', ...x })).join('\n') + '\n');
  const exit = await new Promise(resolve => child.on('close', resolve));
  assert.equal(exit, 0); assert.equal(stderr, '');
  const messages = stdout.trim().split('\n').map(x => JSON.parse(x));
  assert.equal(messages.length, 5); assert.equal(messages[0].error.code, -32002);
  assert.equal(messages[1].result.protocolVersion, '2025-06-18'); assert.equal(messages[2].result.tools.length, 8);
  assert.equal(messages[3].result.isError, true); assert.deepEqual(messages[4].result, {});
});

// Minimal local CDP fixture; it cannot prove Adobe execution.
function wsFrame(text) {
  const payload = Buffer.from(text), header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}
function parseClientFrame(buffer) {
  if (buffer.length < 6) return null;
  let length = buffer[1] & 127, offset = 2;
  if (length === 126) { if (buffer.length < 8) return null; length = buffer.readUInt16BE(2); offset = 4; }
  if (length === 127) throw new Error('Fixture frame too large');
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
  return { text: payload.toString(), bytes: offset + 4 + length, opcode: buffer[0] & 15 };
}
async function fixture(responder) {
  const sockets = new Set(); let port;
  const http = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{ id: 'cep-fixture', title: 'fixture', url: 'file:///fixture/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fixture` }])); });
  http.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  http.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]); let frame;
      while ((frame = parseClientFrame(pending))) {
        pending = pending.subarray(frame.bytes);
        if (frame.opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        const request = JSON.parse(frame.text), response = responder(request);
        if (response) socket.write(wsFrame(JSON.stringify(response)));
      }
    });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); port = http.address().port;
  return { port, async close() { for (const s of sockets) s.destroy(); await new Promise(resolve => http.close(resolve)); } };
}
test('CDP targets exact panel and checks protocol errors, exceptions and timeout', async () => {
  const f = await fixture(req => ({ id: req.id, result: { result: { type: 'object', value: { inspected: true } } } }));
  try {
    const r = await cdpEvaluate({ port: f.port, targetId: 'cep-fixture', expression: '({inspected:true})', timeoutMs: 1000 });
    assert.deepEqual(r.value, { inspected: true });
    await assert.rejects(cdpEvaluate({ port: f.port, targetId: 'other', expression: '1' }), /Exact targetId/);
  } finally { await f.close(); }
  for (const [response, pattern] of [
    [{ id: 1, error: { code: -1, message: 'unsupported protocol' } }, /unsupported protocol/],
    [{ id: 1, result: { exceptionDetails: { text: 'panel failure' } } }, /panel failure/],
    [null, /timeout/]
  ]) {
    const ff = await fixture(() => response);
    try { await assert.rejects(cdpEvaluate({ port: ff.port, targetId: 'cep-fixture', expression: '1', timeoutMs: 100 }), pattern); }
    finally { await ff.close(); }
  }
});
test('bundled transport adapter verifies CEP callback and run identity with a fake host', async () => {
  const f = await fixture(req => {
    const context = fakeHost();
    // Parse the wrapper literal at the evalScript boundary and execute it in the fake host.
    const literal = req.params.expression.match(/evalScript\(("(?:\\.|[^"\\])*"),function/)[1];
    const value = vm.runInContext(JSON.parse(literal), context);
    return { id: req.id, result: { result: { type: 'string', value } } };
  });
  try {
    const r = await callTool('ae_execute_jsx', { transport: 'cdp', port: f.port, targetId: 'cep-fixture', code: 'return {assertion:true};', workDir: work });
    assert.equal(r.success, true); assert.equal(r.data.assertion, true); assert.equal(r.evidenceLevel, 'live-host');
    assert.equal(JSON.parse(await fs.readFile(r.resultPath, 'utf8')).runId, r.runId);
    assert.equal(r.aeVersion, '25.fixture'); // fixture result is harness evidence only.
  } finally { await f.close(); }
});
test('render rejects traversal and invalid range before launching a worker', async () => {
  const fake = path.join(work, 'aerender.exe'), project = path.join(work, 'fixture.aep');
  await fs.writeFile(fake, 'not-executed'); await fs.writeFile(project, 'fixture');
  const a = { aerenderPath: fake, projectPath: project, comp: 'fixture', outputName: '../overwrite.png', workDir: work };
  await assert.rejects(callTool('ae_render_start', a), /outputName/);
  await assert.rejects(callTool('ae_render_start', { ...a, outputName: 'frame.png', startFrame: 2, endFrame: 1 }), /exceeds/);
});
test('asynchronous render worker persists launch failure with logs and no output success', async () => {
  const fake = path.join(work, 'aerender.exe'), project = path.join(work, 'fixture.aep');
  const started = await callTool('ae_render_start', { aerenderPath: fake, projectPath: project, comp: 'fixture', outputName: 'frame[####].png', workDir: work });
  assert.equal(started.state, 'starting');
  let result;
  for (let i = 0; i < 100; i++) {
    result = await callTool('ae_render_status', { jobPath: started.jobPath });
    if (result.state === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(result.state, 'failed'); assert.equal(result.pixelCorrectnessVerified, false); assert.equal(result.outputs.length, 0);
  assert.ok(result.finishedAt); await fs.access(path.join(started.outputDir, 'aerender.stderr.log'));
});
test('read-only schema hints are limited to inspection tools', () => {
  for (const name of ['ae_execute_jsx', 'ae_evaluate_panel', 'ae_render_start']) assert.equal(TOOLS.find(x => x.name === name).annotations.readOnlyHint, false);
  assert.equal(TOOLS.find(x => x.name === 'ae_inspect_host').annotations.readOnlyHint, true);
});
