import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collabCreate, collabRun } from './ae-collab.mjs';
import { TOOLS, hostWrapper, callTool, cdpEvaluate, macBundleAerenderCandidates } from './ae-mcp.mjs';

const serverPath = fileURLToPath(new URL('./ae-mcp.mjs', import.meta.url));
const work = path.resolve(process.env.AE_MCP_TEST_WORK || path.join(process.cwd(), 'work', 'ae-mcp', 'tests'));
await fs.mkdir(work, { recursive: true });
function fakeHost(extra = {}) {
  return vm.createContext({ app: { version: '25.fixture', name: 'Adobe After Effects', project: {} }, CompItem: function CompItem() {}, JSON: undefined, ...extra });
}
test('macOS discovery considers AE app bundle aerender paths', () => {
  const entries = [{ name: 'Adobe After Effects 2025.app', isDirectory: () => true }, { name: 'Other.app', isDirectory: () => true }];
  assert.deepEqual(macBundleAerenderCandidates('/Applications/Adobe After Effects 2025', entries), [path.join('/Applications/Adobe After Effects 2025', 'Adobe After Effects 2025.app', 'Contents/MacOS/aerender')]);
  assert.equal(macBundleAerenderCandidates('/Applications/Adobe After Effects 2025.app', []).length, 1);
});
test('ES3 wrapper preserves Unicode, control characters, quotes and nested JSON without host JSON', () => {
  const code = 'return {text:"中文\\n\\t\\\"\\\\",nested:[1,true,null,{zero:0}],u:"\\u2028",nan:NaN};';
  const actual = JSON.parse(vm.runInContext(hostWrapper({ runId: 'fixture', code }), fakeHost()));
  assert.equal(actual.success, true); assert.equal(actual.stage, 'complete'); assert.equal(actual.aeVersion, '25.fixture');
  assert.deepEqual(actual.data, { text: '中文\n\t"\\', nested: [1, true, null, { zero: 0 }], u: '\u2028', nan: null });
});
test('host execution is distinct from postcondition verification', () => {
  const unverified = JSON.parse(vm.runInContext(hostWrapper({ runId: 'none', code: 'return 1;' }), fakeHost()));
  assert.equal(unverified.success, true); assert.equal(unverified.verificationStatus, 'not_requested');
  const collabResult = JSON.parse(vm.runInContext(hostWrapper({runId:'shared',code:'return {verified:true};',verifyCode:'return result.data && result.data.verified === true;'}), fakeHost()));
  assert.equal(collabResult.verificationStatus, 'passed');
  const passed = JSON.parse(vm.runInContext(hostWrapper({ runId: 'pass', code: 'app.project.value=42;', verifyCode: 'return app.project.value === 42;' }), fakeHost()));
  assert.equal(passed.success, true); assert.equal(passed.verificationStatus, 'passed');
  const failed = JSON.parse(vm.runInContext(hostWrapper({ runId: 'fail', code: 'app.project.value=1;', verifyCode: 'return app.project.value === 42;' }), fakeHost()));
  assert.equal(failed.success, false); assert.match(failed.errors[0].message, /Postcondition/);
});
test('managed session preview and cleanup skip pending work', async () => {
  if (process.platform !== 'win32') return;
  const session = await callTool('ae_test_session_create', {});
  const run = path.join(session.sessionDir, 'ae-mcp-pending');
  await fs.mkdir(run); await fs.writeFile(path.join(run, 'request.json'), JSON.stringify({ runId: 'ae-mcp-pending' }));
  const preview = await callTool('ae_test_cleanup', {});
  assert.equal(preview.sessions.find(x => x.sessionId === session.sessionId).action, 'skipped');
  await fs.writeFile(path.join(run, 'host-result.json'), JSON.stringify({ runId: 'ae-mcp-pending', stage: 'complete' }));
  const eligible = await callTool('ae_test_cleanup', {});
  assert.equal(eligible.sessions.find(x => x.sessionId === session.sessionId).action, 'eligible');
  const deletion = await callTool('ae_test_cleanup', { delete: true, sessionId: session.sessionId });
  assert.equal(deletion.sessions[0].action, 'deleted');
  await assert.rejects(fs.access(session.sessionDir));
});
test('collaboration coordinates claims, handoff, notes and managed cleanup', async () => {
  const fakeCreate = async () => {
    const session = await callTool('ae_test_session_create', {});
    await fs.writeFile(path.join(session.sessionDir, '.ae-mcp-collab.json'), JSON.stringify({schemaVersion:1,sessionId:session.sessionId,state:'initializing',claims:[],notes:[]}));
    return session;
  };
  const fakeExecute = async () => ({success:true, resultPath:'fixture', data:{verified:true,compId:123}});
  const session = await collabCreate({}, fakeCreate, fakeExecute);
  const sessionId = session.sessionId;
  try {
    await callTool('ae_collab_claim', {sessionId,agentId:'agent_a',compName:'Comp A'});
    await assert.rejects(callTool('ae_collab_claim', {sessionId,agentId:'agent_b',compName:'Comp A'}), /already claimed/);
    await callTool('ae_collab_claim', {sessionId,agentId:'agent_b',compName:'Comp B'});
    await callTool('ae_collab_note', {sessionId,agentId:'agent_a',message:'Ready for review'});
    const result = await collabRun({sessionId,agentId:'agent_a',compName:'Comp A',code:'return 1;',verifyCode:'return true;'}, fakeExecute);
    assert.equal(result.committed,true);
    let status = await callTool('ae_collab_status',{sessionId});
    assert.equal(status.claims.length,2); assert.equal(status.notes[0].message,'Ready for review'); assert.equal(status.comps[0].compId,123);
    if (process.platform === 'win32') {
      const preview = await callTool('ae_test_cleanup',{sessionId});
      assert.equal(preview.sessions[0].action,'skipped');
    }
    await assert.rejects(callTool('ae_collab_close',{sessionId}), /Release all/);
    await callTool('ae_collab_release',{sessionId,agentId:'agent_a',compName:'Comp A'});
    await callTool('ae_collab_claim',{sessionId,agentId:'agent_b',compName:'Comp A'});
    status = await callTool('ae_collab_status',{sessionId});
    assert.equal(status.claims.find(x=>x.compName==='Comp A').compId,123);
    await callTool('ae_collab_release',{sessionId,agentId:'agent_b',compName:'Comp A'});
    await callTool('ae_collab_release',{sessionId,agentId:'agent_b',compName:'Comp B'});
    await callTool('ae_collab_close',{sessionId});
    await assert.rejects(callTool('ae_collab_claim',{sessionId,agentId:'agent_a',compName:'Comp A'}), /not active/);
    if (process.platform === 'win32') {
      const removed = await callTool('ae_test_cleanup',{delete:true,sessionId});
      assert.equal(removed.sessions[0].action,'deleted');
    }
  } finally {
    // The fixture owns this exact path and never starts an AE process.
    assert.equal(path.dirname(session.sessionDir), path.join((await import('node:os')).tmpdir(),'AEffectMCP-managed-tests'));
    await fs.rm(session.sessionDir,{recursive:true,force:true});
  }
});
test('existing project is copied and duplicate comp names use stable IDs', async () => {
  const dir = await fs.mkdtemp(path.join(work,'source-copy-'));
  const source = path.join(dir,'original.aepx');
  const contents = 'original fixture data'; await fs.writeFile(source, contents);
  const fakeCreate = async () => {
    const session = await callTool('ae_test_session_create', {});
    await fs.writeFile(path.join(session.sessionDir,'.ae-mcp-collab.json'),JSON.stringify({schemaVersion:1,sessionId:session.sessionId,state:'initializing',claims:[],notes:[]}));
    return session;
  };
  let session;
  try {
    await assert.rejects(collabCreate({sourceProjectPath:'relative.aep'},fakeCreate,async()=>{}),/absolute/);
    session = await collabCreate({sourceProjectPath:source},fakeCreate,async(args)=>{
      assert.match(args.code,/app\.open\(f\)/);
      assert.doesNotThrow(() => new vm.Script(hostWrapper({runId:'syntax', code:args.code, verifyCode:args.verifyCode, isolated:true})));
      return {success:true,resultPath:'fixture',data:{comps:[{compName:'Duplicate',compId:10},{compName:'Duplicate',compId:20}],missingFootageCount:1,missingFootage:['offline.mov']}};
    });
    assert.notEqual(session.projectPath,source); assert.match(session.projectPath,/test-project\.aepx$/);
    assert.equal(await fs.readFile(session.projectPath,'utf8'),contents);
    assert.equal(session.source.sha256,createHash('sha256').update(contents).digest('hex'));
    assert.equal(session.missingFootageCount,1);
    await assert.rejects(callTool('ae_collab_claim',{sessionId:session.sessionId,agentId:'a',compName:'Duplicate'}),/provide compId/);
    await assert.rejects(callTool('ae_collab_claim',{sessionId:session.sessionId,agentId:'a',compName:'Wrong'}),/not found/);
    for (const [agentId,compId] of [['a',10],['b',20]]) await callTool('ae_collab_claim',{sessionId:session.sessionId,agentId,compName:'Duplicate',compId});
    const run = await collabRun({sessionId:session.sessionId,agentId:'a',compName:'Duplicate',compId:10,code:'return 1;',verifyCode:'return true;'},async(args)=>{
      assert.ok(args.code.includes('test-project.aepx')); assert.ok(!args.code.includes('original.aepx'));
      await fs.writeFile(session.projectPath,'modified copy');
      return {success:true,resultPath:'fixture',data:{verified:true,compId:10}};
    });
    assert.equal(run.committed,true); assert.equal(await fs.readFile(source,'utf8'),contents);
    const status=await callTool('ae_collab_status',{sessionId:session.sessionId});
    assert.equal(status.comps.length,2); assert.deepEqual(status.comps.map(x=>x.compId),[10,20]);
    for (const [agentId,compId] of [['a',10],['b',20]]) await callTool('ae_collab_release',{sessionId:session.sessionId,agentId,compName:'Duplicate',compId});
    await callTool('ae_collab_close',{sessionId:session.sessionId});
  } finally {
    if(session) { assert.equal(path.dirname(session.sessionDir),path.join((await import('node:os')).tmpdir(),'AEffectMCP-managed-tests')); await fs.rm(session.sessionDir,{recursive:true,force:true}); }
    await fs.rm(dir,{recursive:true,force:true});
  }
});
test('separate MCP processes cannot claim the same composition', async () => {
  const fakeCreate = async () => {
    const session = await callTool('ae_test_session_create', {});
    await fs.writeFile(path.join(session.sessionDir, '.ae-mcp-collab.json'), JSON.stringify({schemaVersion:1,sessionId:session.sessionId,state:'initializing',claims:[],notes:[]}));
    return session;
  };
  const session = await collabCreate({}, fakeCreate, async()=>({success:true,resultPath:'fixture'}));
  const dir = await fs.mkdtemp(path.join(work,'claim-race-'));
  try {
    async function competing(agentId) {
      const f = path.join(dir,agentId+'.json');
      await fs.writeFile(f,JSON.stringify({sessionId:session.sessionId,agentId,compName:'Shared'}));
      const child = spawn(process.execPath,[serverPath,'--call','ae_collab_claim','--args-file',f],{windowsHide:true});
      let stderr='';child.stderr.on('data',d=>stderr+=d);
      const code = await new Promise(resolve=>child.on('close',resolve));
      return {code,stderr};
    }
    const results = await Promise.all([competing('a'),competing('b')]);
    assert.equal(results.filter(x=>x.code===0).length,1);
    assert.match(results.find(x=>x.code!==0).stderr,/busy or blocked|already claimed/);
    const status = await callTool('ae_collab_status',{sessionId:session.sessionId});
    assert.equal(status.claims.length,1);
  } finally {
    assert.equal(path.dirname(session.sessionDir),path.join((await import('node:os')).tmpdir(),'AEffectMCP-managed-tests'));
    await fs.rm(session.sessionDir,{recursive:true,force:true});
    await fs.rm(dir,{recursive:true,force:true});
  }
});
test('collaboration timeout retains lock and blocks other writers', async () => {
  const fakeCreate = async () => {
    const session = await callTool('ae_test_session_create', {});
    await fs.writeFile(path.join(session.sessionDir, '.ae-mcp-collab.json'), JSON.stringify({schemaVersion:1,sessionId:session.sessionId,state:'initializing',claims:[],notes:[]}));
    return session;
  };
  const session = await collabCreate({}, fakeCreate, async()=>({success:true,resultPath:'fixture'}));
  try {
    await callTool('ae_collab_claim',{sessionId:session.sessionId,agentId:'agent_a',compName:'A'});
    await assert.rejects(collabRun({sessionId:session.sessionId,agentId:'agent_a',compName:'A',code:'return 1;',verifyCode:'return true;'}, async()=>{throw new Error('timeout');}),/remains locked/);
    assert.equal((await callTool('ae_collab_status',{sessionId:session.sessionId})).locked,true);
    await assert.rejects(callTool('ae_collab_claim',{sessionId:session.sessionId,agentId:'agent_b',compName:'B'}),/busy or blocked/);
    if (process.platform === 'win32') assert.equal((await callTool('ae_test_cleanup',{sessionId:session.sessionId})).sessions[0].action,'skipped');
    await assert.rejects(callTool('ae_collab_resolve',{sessionId:session.sessionId,agentId:'operator',reason:'fixture',confirmHelperStopped:false,acceptSavedProject:true}),/explicit confirmation/);
    const recovered = await callTool('ae_collab_resolve',{sessionId:session.sessionId,agentId:'operator',reason:'No real process was started in this fixture',confirmHelperStopped:true,acceptSavedProject:true});
    assert.equal(recovered.recovered,true); assert.equal((await callTool('ae_collab_status',{sessionId:session.sessionId})).locked,false);
  } finally {
    assert.equal(path.dirname(session.sessionDir), path.join((await import('node:os')).tmpdir(),'AEffectMCP-managed-tests'));
    await fs.rm(session.sessionDir,{recursive:true,force:true});
  }
});
test('JSX status distinguishes missing, partial, stale and completed host results', async () => {
  const dir = await fs.mkdtemp(path.join(work, 'status-'));
  const resultPath = path.join(dir, 'host-result.json');
  await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify({runId:'r1'}));
  assert.equal((await callTool('ae_jsx_status', {resultPath})).state, 'unknown');
  await fs.writeFile(resultPath, '{');
  assert.equal((await callTool('ae_jsx_status', {resultPath})).state, 'unknown');
  await fs.writeFile(resultPath, JSON.stringify({runId:'r1',stage:'executing'}));
  assert.equal((await callTool('ae_jsx_status', {resultPath})).state, 'pending_or_unknown');
  await fs.writeFile(resultPath, JSON.stringify({runId:'other',stage:'complete'}));
  await assert.rejects(callTool('ae_jsx_status', {resultPath}), /Stale/);
  await fs.writeFile(resultPath, JSON.stringify({runId:'r1',stage:'complete',aeVersion:'25',success:true}));
  assert.equal((await callTool('ae_jsx_status', {resultPath})).state, 'complete');
  await fs.rm(dir,{recursive:true});
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
  const byId = new Map(messages.map(m => [m.id, m]));
  assert.equal(messages.length, 5); assert.equal(byId.get(0).error.code, -32002);
  assert.equal(byId.get(1).result.protocolVersion, '2025-06-18'); assert.equal(byId.get(2).result.tools.length, 19);
  assert.equal(byId.get(3).result.isError, true); assert.deepEqual(byId.get(4).result, {});
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
test('stdio responds to ping while a panel call is waiting', async () => {
  const f = await fixture(() => null);
  const child = spawn(process.execPath, [serverPath, '--stdio'], { windowsHide: true });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ id: 2, method: 'tools/call', params: { name: 'ae_evaluate_panel', arguments: { port: f.port, targetId: 'cep-fixture', expression: '1', timeoutMs: 700 } } });
    await new Promise(r => setTimeout(r, 200));
    send({ id: 3, method: 'ping' });
    await new Promise(r => setTimeout(r, 200));
    const replies = stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(replies.some(x => x.id === 3));
    assert.ok(!replies.some(x => x.id === 2));
  } finally {
    child.stdin.end();
    await new Promise(resolve => child.on('close', resolve));
    await f.close();
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
  for (const outputName of ['render-job.json', 'WORKER.LOG', 'aerender.stdout.log', 'aerender.stderr.log']) {
    await assert.rejects(callTool('ae_render_start', { ...a, outputName }), /reserved/);
  }
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
