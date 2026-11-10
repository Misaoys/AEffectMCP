import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = path.join(os.tmpdir(), 'AEffectMCP-managed-tests');
const tag = '.ae-mcp-collab.json';
const lockName = '.ae-mcp-collab-lock';
function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error(label + ' must use 1-64 ASCII letters, digits, _ or -');
  return value;
}
async function write(p, data) {
  const temp = p + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, p);
}
async function sessionPath(sessionId) {
  if (!/^session-[A-Za-z0-9]+$/.test(sessionId || '')) throw new Error('Invalid sessionId');
  const root = await fs.lstat(ROOT);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid managed root');
  const dir = path.join(ROOT, sessionId);
  const item = await fs.lstat(dir);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('Invalid session directory');
  const marker = JSON.parse(await fs.readFile(path.join(dir, '.ae-mcp-session.json'), 'utf8'));
  if (marker.sessionId !== sessionId) throw new Error('Invalid managed session marker');
  return dir;
}
async function metadata(dir) {
  const item = await fs.lstat(path.join(dir, tag));
  if (!item.isFile() || item.isSymbolicLink()) throw new Error('Invalid collaboration metadata');
  const data = JSON.parse(await fs.readFile(path.join(dir, tag), 'utf8'));
  if (data.schemaVersion !== 1 || data.sessionId !== path.basename(dir)) throw new Error('Invalid collaboration session');
  return data;
}
async function locked(dir, operation, fn) {
  const lock = path.join(dir, lockName);
  try { await fs.mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error('Collaboration session busy or blocked; no operation was started. Inspect ae_collab_status.'); throw e; }
  let retain = false;
  try {
    await write(path.join(lock, 'owner.json'), { operation, pid: process.pid, startedAt: new Date().toISOString() });
    const control = { retain() { retain = true; } };
    return await fn(control);
  } finally { if (!retain) await fs.rm(lock, { recursive: true, force: true }); }
}
function active(m) { if (m.state !== 'active') throw new Error('Collaboration session is not active'); }
function projectPath(dir, data) {
  const expected = path.join(dir, data.source ? 'test-project' + data.source.extension : 'test-project.aep');
  if (path.resolve(data.projectPath) !== expected) throw new Error('Invalid shared project path');
  return expected;
}
async function digest(p) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(p)) hash.update(chunk);
  return hash.digest('hex');
}
async function snapshot(source, target) {
  const before = await fs.stat(source);
  if (!before.isFile()) throw new Error('Source project must be a regular file');
  const beforeHash = await digest(source);
  await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
  const [copyHash, afterHash, after] = await Promise.all([digest(target), digest(source), fs.stat(source)]);
  if (beforeHash !== copyHash || beforeHash !== afterHash || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Source changed while copying; snapshot rejected');
  return { sha256: beforeHash, bytes: before.size, sourceMtimeMs: before.mtimeMs };
}
function jsxPath(p) { return JSON.stringify(p.replace(/\\/g, '/')); }

export async function collabCreate(a, createSession, execute) {
  let source = null;
  if (a.sourceProjectPath) {
    if (!path.isAbsolute(a.sourceProjectPath)) throw new Error('sourceProjectPath must be absolute');
    const resolved = await fs.realpath(a.sourceProjectPath);
    const extension = path.extname(resolved).toLowerCase();
    if (!['.aep', '.aepx'].includes(extension)) throw new Error('Source must be an existing .aep or .aepx file');
    if (!(await fs.stat(resolved)).isFile()) throw new Error('Source project must be a regular file');
    source = { path: resolved, extension };
  }
  const session = await createSession(true), dir = session.sessionDir;
  if (source) session.projectPath = path.join(dir, 'test-project' + source.extension);
  const initial = { schemaVersion: 1, sessionId: session.sessionId, state: 'initializing', projectPath: session.projectPath, source, claims: [], comps: [], notes: [] };
  await write(path.join(dir, tag), initial);
  return locked(dir, 'initialize', async control => {
    if (source) {
      try { Object.assign(source, await snapshot(source.path, session.projectPath)); await write(path.join(dir, tag), initial); }
      catch (e) {
        initial.state = 'closed'; initial.initializationError = 'Snapshot rejected'; await write(path.join(dir, tag), initial);
        throw new Error('Source snapshot rejected; sessionId=' + session.sessionId + '; ' + e.message);
      }
    }
    control.retain();
    const p = jsxPath(session.projectPath);
    const inspect = `var names=[],missing=[],missingCount=0;for(var i=1;i<=app.project.numItems;i++){var x=app.project.item(i);` +
      `if(x instanceof CompItem)names.push({compName:x.name,compId:x.id});` +
      `try{if(typeof FootageItem!=='undefined' && x instanceof FootageItem && x.footageMissing){missingCount++;if(missing.length<50)missing.push(x.name);}}catch(ignore){}}` +
      `return {project:app.project.file.fsName,comps:names,missingFootageCount:missingCount,missingFootage:missing};`;
    const code = source ? `var f=new File(${p});if(!f.exists)throw new Error('Snapshot missing');app.open(f);` + inspect :
      `app.project.save(new File(${p}));` + inspect;
    let result;
    try { result = await execute({ launchMode: 'isolated', afterfxPath: a.afterfxPath, workDir: dir, timeoutMs: a.timeoutMs || 55000, code,
      verifyCode: `return app.project.file && app.project.file.fsName.replace(/\\\\/g,'/').toLowerCase()===${p}.toLowerCase();` }); }
    catch (e) { throw new Error('Collaboration initialization blocked; sessionId=' + session.sessionId + '; ' + e.message); }
    if (!result.success) throw new Error('Initial project inspection failed; sessionId=' + session.sessionId + '; session locked. result=' + result.resultPath);
    if (source && !Array.isArray(result.data?.comps)) throw new Error('Composition inventory missing; sessionId=' + session.sessionId + '; session remains locked');
    initial.comps = result.data?.comps || []; initial.missingFootageCount = result.data?.missingFootageCount ?? null;
    initial.missingFootage = result.data?.missingFootage || [];
    initial.state = 'active'; initial.createdAt = new Date().toISOString();
    await write(path.join(dir, tag), initial);
    await fs.rm(path.join(dir, lockName), { recursive: true });
    return { ...session, state: 'active', source, comps: initial.comps, missingFootageCount: initial.missingFootageCount, missingFootage: initial.missingFootage, resultPath: result.resultPath, coordination: 'Serialized isolated helpers share one saved project copy; use only collaboration tools for writes.' };
  });
}
export async function collabStatus(a) {
  const dir = await sessionPath(a.sessionId), data = await metadata(dir);
  const lock = await fs.readFile(path.join(dir, lockName, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
  const lockedNow = !!(await fs.lstat(path.join(dir, lockName)).catch(() => null));
  return { ...data, sessionDir: dir, locked: lockedNow, lock };
}
function selectClaim(data, a, agentId) {
  const matches = data.claims.filter(x => x.compName === a.compName && x.agentId === agentId && (a.compId === undefined || x.compId === a.compId));
  if (matches.length > 1) throw new Error('Ambiguous composition name; provide compId');
  if (!matches.length) throw new Error('Composition is not claimed by this agent');
  return matches[0];
}
export async function collabClaim(a) {
  const dir = await sessionPath(a.sessionId), agentId = id(a.agentId, 'agentId');
  const name = a.compName;
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\x00-\x1f]/.test(name)) throw new Error('Invalid compName');
  return locked(dir, 'claim', async () => {
    const data = await metadata(dir); active(data);
    const matches = (data.comps || []).filter(x => x.compName === name && (a.compId === undefined || x.compId === a.compId));
    if (matches.length > 1) throw new Error('Ambiguous composition name; provide compId');
    if (!matches.length && (data.source || a.compId !== undefined)) throw new Error('Composition not found in shared project inventory');
    const saved = matches[0];
    const existing = data.claims.find(x => saved ? x.compId === saved.compId : x.compName === name && x.compId === null);
    if (existing && existing.agentId !== agentId) throw new Error('Composition is already claimed by ' + existing.agentId);
    if (!existing) data.claims.push({ agentId, compName: name, compId: saved?.compId ?? null });
    await write(path.join(dir, tag), data);
    return { sessionId: a.sessionId, agentId, compName: name, compId: saved?.compId ?? null, projectPath: data.projectPath, claim: existing ? 'already_owned' : 'claimed' };
  });
}
export async function collabRelease(a) {
  const dir = await sessionPath(a.sessionId), agentId = id(a.agentId, 'agentId');
  return locked(dir, 'release', async () => {
    const data = await metadata(dir); active(data);
    const claim = selectClaim(data, a, agentId);
    data.claims = data.claims.filter(x => x !== claim); await write(path.join(dir, tag), data);
    return { sessionId: a.sessionId, agentId, compName: a.compName, compId: claim.compId, released: true };
  });
}
export async function collabNote(a) {
  const dir = await sessionPath(a.sessionId), agentId = id(a.agentId, 'agentId');
  if (typeof a.message !== 'string' || !a.message.trim() || a.message.length > 2000) throw new Error('message must contain 1-2000 characters');
  return locked(dir, 'note', async () => {
    const data = await metadata(dir); active(data);
    if (data.notes.length >= 100) throw new Error('Note limit reached; read and archive the session before closing');
    const note = { agentId, message: a.message, createdAt: new Date().toISOString() };
    data.notes.push(note); await write(path.join(dir, tag), data); return note;
  });
}
export async function collabRun(a, execute) {
  const dir = await sessionPath(a.sessionId), agentId = id(a.agentId, 'agentId');
  return locked(dir, 'run:' + agentId, async control => {
    const data = await metadata(dir); active(data);
    const claim = selectClaim(data, a, agentId);
    const p = jsxPath(projectPath(dir, data)), name = JSON.stringify(a.compName), expected = JSON.stringify(claim.compId);
    const code = `var f=new File(${p});if(!f.exists)throw new Error('Shared project missing');app.open(f);` +
      `if(!app.project.file||app.project.file.fsName.replace(/\\\\/g,'/').toLowerCase()!==${p}.toLowerCase())throw new Error('Wrong shared project');` +
      `var comp=null,count=0,i,x;for(i=1;i<=app.project.numItems;i++){x=app.project.item(i);if(x instanceof CompItem && x.name===${name} && (${expected}===null || x.id===${expected})){comp=x;count++;}}` +
      `if(count>1)throw new Error('Duplicate composition name');if(!comp){if(${expected}!==null)throw new Error('Claimed composition missing');comp=app.project.items.addComp(${name},${a.width || 512},${a.height || 512},1,${a.duration || 5},${a.frameRate || 30});}` +
      `if(${expected}!==null && comp.id!==${expected})throw new Error('Composition identity changed');var originalId=comp.id;` +
      `var value=(function(comp){\n${a.code}\n})(comp);` +
      `var verified=(function(comp){\n${a.verifyCode}\n})(comp);if(verified!==true)throw new Error('Collaboration postcondition must return true');` +
      `if(!app.project.file||app.project.file.fsName.replace(/\\\\/g,'/').toLowerCase()!==${p}.toLowerCase()||comp.id!==originalId||comp.name!==${name})throw new Error('Project or composition identity changed');` +
      `app.project.save();return {compId:comp.id,compName:comp.name,project:app.project.file.fsName,verified:true,value:value};`;
    control.retain();
    let result;
    try { result = await execute({ launchMode: 'isolated', afterfxPath: a.afterfxPath, workDir: dir, timeoutMs: a.timeoutMs || 55000, code, verifyCode: 'return result.data && result.data.verified === true;' }); }
    catch (e) { throw new Error('Collaboration session remains locked; sessionId=' + a.sessionId + '; ' + e.message); }
    if (!result.success || result.data?.verified !== true) throw new Error('Collaboration operation failed or unverified; session remains locked. result=' + result.resultPath);
    claim.compId = result.data.compId; data.comps ||= [];
    const registered = data.comps.find(x => x.compId === claim.compId);
    if (registered) registered.compId = claim.compId; else data.comps.push({ compName: claim.compName, compId: claim.compId });
    data.lastCommit = { agentId, compName: claim.compName, compId: claim.compId, resultPath: result.resultPath, committedAt: new Date().toISOString() };
    await write(path.join(dir, tag), data);
    await fs.rm(path.join(dir, lockName), { recursive: true });
    return { ...result, verificationStatus: 'passed', verifiedScope: 'Supplied postcondition passed in the shared project; rendering and other behaviors require separate verification.', committed: true, sessionId: a.sessionId, agentId, projectPath: data.projectPath };
  });
}
export async function collabClose(a) {
  const dir = await sessionPath(a.sessionId);
  return locked(dir, 'close', async () => {
    const data = await metadata(dir); active(data);
    if (data.claims.length) throw new Error('Release all composition claims before closing');
    data.state = 'closed'; data.closedAt = new Date().toISOString(); await write(path.join(dir, tag), data);
    return { sessionId: a.sessionId, state: data.state, projectPath: data.projectPath };
  });
}

// Operator-only recovery after independently confirming that every helper is stopped.
export async function collabResolve(a) {
  if (a.confirmHelperStopped !== true || a.acceptSavedProject !== true) throw new Error('Recovery requires explicit confirmation that helpers stopped and the saved AEP was inspected');
  const dir = await sessionPath(a.sessionId), agentId = id(a.agentId, 'agentId');
  if (typeof a.reason !== 'string' || !a.reason.trim() || a.reason.length > 1000) throw new Error('A recovery reason is required');
  const lock = path.join(dir, lockName);
  const stat = await fs.lstat(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid lock');
  const recoveryPath = path.join(lock, 'recovery.json');
  const handle = await fs.open(recoveryPath, 'wx');
  try {
    await handle.writeFile(JSON.stringify({ agentId, reason: a.reason, at: new Date().toISOString() }));
    const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
    if (!owner.operation || !/^(run:|initialize)/.test(owner.operation)) throw new Error('Only unresolved AE operations can be recovered');
    const data = await metadata(dir);
    data.lastRecovery = { agentId, reason: a.reason, previousOperation: owner.operation, at: new Date().toISOString() };
    if (data.state === 'initializing') data.state = 'closed';
    else active(data);
    await write(path.join(dir, tag), data);
    await fs.unlink(path.join(lock, 'owner.json'));
  } finally { await handle.close(); }
  await fs.unlink(recoveryPath);
  await fs.rmdir(lock);
  return { sessionId: a.sessionId, state: (await metadata(dir)).state, recovered: true, message: 'Lock released after operator confirmation; inspect the saved AEP before continuing.' };
}
