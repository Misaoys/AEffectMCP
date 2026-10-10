import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SUPPORTED = ['2025-11-25', '2025-06-18', '2024-11-05'];
const str = { type: 'string', minLength: 1 };
const integer = { type: 'integer' };
const transport = {
  transport: { type: 'string', enum: ['cli', 'cdp'] },
  launchMode: { type: 'string', enum: ['existing', 'isolated'] },
  afterfxPath: str, port: { type: 'integer', minimum: 1024, maximum: 65534 },
  targetId: str, workDir: str,
  timeoutMs: { type: 'integer', minimum: 100, maximum: 55000 }
};
function tool(name, description, properties, required = [], readOnly = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false } };
}
export const TOOLS = [
  tool('ae_discover', 'Find AE executables, running Windows hosts and installed CEP roots. No host is started.', { roots: { type: 'array', items: str } }, [], true),
  tool('ae_cep_targets', 'List targets on an explicit loopback CEP debug port. Select the installed extension target before evaluating.', { port: transport.port }, ['port'], true),
  tool('ae_inspect_host', 'Read real AE version, project, active comp/layers, render queue and optional effect registry; writes a fresh probe result.', { ...transport, includeEffects: { type: 'boolean' }, maxItems: { type: 'integer', minimum: 1, maximum: 500 } }, [], true),
  tool('ae_execute_jsx', 'Execute authorized JSX in AE via AfterFX -r or a real CEP evalScript bridge. Supply exactly one of code or scriptPath. Code is a function body returning JSON-compatible data. Timeout does not cancel execution; never blindly retry mutations.', { ...transport, code: str, scriptPath: str, undoGroup: str }, []),
  tool('ae_evaluate_panel', 'Evaluate authorized panel JavaScript through CEP CDP without computer use. Can inspect DOM, call panel APIs or drive DOM events. Does not prove AE behavior without a host result.', { port: transport.port, targetId: str, expression: str, timeoutMs: transport.timeoutMs }, ['port', 'targetId', 'expression']),
  tool('ae_collect_diagnostics', 'Run the bundled read-only Windows CEP/manifest/install/log collector and retain its JSON evidence.', { repoPath: str, extensionRoot: str, extensionId: str, workDir: str, since: str }, [] , true),
  tool('ae_render_start', 'Start aerender on an explicit saved project and comp in a separate owned process. Output goes into a unique run directory. Returns immediately; poll ae_render_status. Does not reuse the user host.', {
    aerenderPath: str, projectPath: str, comp: str, workDir: str, outputName: str, outputModule: str, renderSettings: str,
    startFrame: integer, endFrame: integer, mfr: { type: 'string', enum: ['ON', 'OFF'] }, maxCpuPercent: { type: 'integer', minimum: 1, maximum: 100 }
  }, ['projectPath', 'comp', 'outputName']),
  tool('ae_render_status', 'Read a render job result and output inventory. Exit zero and nonempty outputs prove delivery only; compare pixels/frames for behavior assertions.', { jobPath: str }, ['jobPath'], true)
];
function validate(name, args) {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error('Unknown tool: ' + name);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const k of t.inputSchema.required) if (!(k in args)) throw new Error('Missing argument: ' + k);
  for (const [k, v] of Object.entries(args)) {
    const s = t.inputSchema.properties[k];
    if (!s) throw new Error('Unknown argument: ' + k);
    const valid = s.type === 'array' ? Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0) :
      s.type === 'integer' ? Number.isSafeInteger(v) : typeof v === s.type;
    if (!valid || (s.minLength && !v.length) || (s.minimum !== undefined && v < s.minimum) ||
        (s.maximum !== undefined && v > s.maximum) || (s.enum && !s.enum.includes(v))) throw new Error('Invalid argument: ' + k);
  }
}
function absolute(p, label) {
  if (!p || !path.isAbsolute(p)) throw new Error(label + ' must be an absolute path');
  return path.resolve(p);
}
async function executable(p, base) {
  p = absolute(p, base);
  if (!base.test(path.basename(p))) throw new Error('Unexpected executable name');
  if (!(await fs.stat(p)).isFile()) throw new Error('Executable is not a file');
  return p;
}
async function runDirectory(a) {
  const root = absolute(a.workDir || process.env.AE_MCP_WORK_DIR || path.join(process.cwd(), 'work', 'ae-mcp'), 'workDir');
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, 'ae-mcp-'));
}
async function jsonWrite(p, data) {
  const temporary = p + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temporary, p);
}
function capture(command, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => finish(new Error('Helper timeout; execution may still be active. No automatic retry or process kill.')), timeoutMs);
    function finish(error, code) {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { child.unref(); reject(error); } else resolve({ exitCode: code, stdout, stderr });
    }
    child.stdout.on('data', d => { if (stdout.length < 4_000_000) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < 1_000_000) stderr += d; });
    child.on('error', e => finish(e)); child.on('close', code => finish(null, code));
  });
}
async function discover(a) {
  const roots = a.roots || (process.platform === 'win32' ? ['C:/Program Files/Adobe', 'D:/Program Files/Adobe', 'E:/Program Files/Adobe'] : ['/Applications']);
  const installations = [];
  for (const root of roots) {
    absolute(root, 'root');
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const candidates = [root, ...entries.filter(x => x.isDirectory() && /after effects/i.test(x.name)).map(x => path.join(root, x.name))];
    for (const c of candidates) for (const rel of ['Support Files/AfterFX.exe', 'Support Files/AfterFX.com', 'AfterFX.exe', 'AfterFX.com', 'aerender', 'Support Files/aerender.exe']) {
      const p = path.join(c, rel); if ((await fs.stat(p).catch(() => null))?.isFile()) installations.push(p);
    }
  }
  let processes = null, processError = null;
  if (process.platform === 'win32') {
    try {
      const r = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(AfterFX|AfterFX.com|aerender|CEPHtmlEngine)$' } | Select-Object ProcessName,Id,Path) | ConvertTo-Json -Compress" ]);
      if (r.exitCode !== 0) throw new Error(r.stderr || 'Process discovery failed');
      processes = JSON.parse(r.stdout.trim() || '[]');
    } catch (e) { processError = e.message; }
  }
  const cepRoots = process.platform === 'win32' ? [path.join(os.homedir(), 'AppData/Roaming/Adobe/CEP/extensions'), 'C:/Program Files/Common Files/Adobe/CEP/extensions', 'C:/Program Files (x86)/Common Files/Adobe/CEP/extensions'] : [path.join(os.homedir(), 'Library/Application Support/Adobe/CEP/extensions'), '/Library/Application Support/Adobe/CEP/extensions'];
  const extensions = [];
  for (const root of cepRoots) for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const p = path.join(root, entry.name);
    extensions.push({ root: p, manifestPath: path.join(p, 'CSXS/manifest.xml'), debugFile: await fs.readFile(path.join(p, '.debug'), 'utf8').catch(() => null) });
  }
  return { platform: process.platform, installations: [...new Set(installations)],
    configuredExecutables: { afterfxPath: process.env.AE_MCP_AFTERFX || null, aerenderPath: process.env.AE_MCP_AERENDER || null },
    processes, processError, extensions, nodeVersion: process.version };
}
async function targets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('CEP target discovery HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('CEP target discovery returned a non-array');
  return data;
}
export async function cdpEvaluate(a) {
  const list = await targets(a.port);
  const selected = list.find(t => String(t.id) === a.targetId);
  if (!selected?.webSocketDebuggerUrl) throw new Error('Exact targetId not found; list CEP targets again');
  const url = new URL(selected.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || Number(url.port) !== a.port) throw new Error('Debug websocket must remain on the selected loopback port');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let done = false;
    const timer = setTimeout(() => finish(new Error('CEP/CDP timeout; host or panel operation may still execute. Do not retry mutations.')), a.timeoutMs || 30000);
    function finish(error, value) { if (done) return; done = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); }
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: a.expression, awaitPromise: true, returnByValue: true } })));
    socket.addEventListener('error', () => finish(new Error('CEP debug websocket error')));
    socket.addEventListener('close', () => { if (!done) finish(new Error('CEP debug websocket closed before response')); });
    socket.addEventListener('message', e => {
      let data; try { data = JSON.parse(e.data); } catch { return; }
      if (data.id !== 1) return;
      if (data.error || data.result?.exceptionDetails) return finish(new Error(JSON.stringify(data.error || data.result.exceptionDetails)));
      const remote = data.result?.result;
      if (!remote) return finish(new Error('CDP response missing result'));
      finish(null, { target: { id: selected.id, title: selected.title, url: selected.url }, value: remote.value, type: remote.type });
    });
  });
}
// ES3-compatible local serializer; do not depend on JSON being present in ExtendScript.
const SERIALIZER = String.raw`
function encode(v) {
  function quote(s) { return '"' + String(s).replace(/[\\"\u0000-\u001f\u2028\u2029]/g, function(c) {
    if (c === '"') return '\\"'; if (c === '\\') return '\\\\';
    var h = c.charCodeAt(0).toString(16); return '\\u' + ('0000' + h).slice(-4);
  }) + '"'; }
  if (v === null || typeof v === 'undefined') return 'null';
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  var parts = [], k;
  if (v instanceof Array) { for (k = 0; k < v.length; k++) parts.push(encode(v[k])); return '[' + parts.join(',') + ']'; }
  for (k in v) if (v.hasOwnProperty(k)) parts.push(quote(k) + ':' + encode(v[k]));
  return '{' + parts.join(',') + '}';
}`;
export function hostWrapper({ runId, code, resultPath, undoGroup, isolated = false }) {
  return `(function(){\n${SERIALIZER}\n` +
    `var result={schemaVersion:1,runId:${JSON.stringify(runId)},success:false,stage:'starting',startedAt:(new Date()).getTime(),aeVersion:null,aeName:null,data:null,errors:[]};\n` +
    `var output=${JSON.stringify(resultPath || null)}, undo=false;\n` +
    `function persist(){if(!output)return;var f=new File(output);f.encoding='UTF-8';if(!f.open('w'))throw new Error('Result file open failed: '+f.error);try{if(!f.write(encode(result)))throw new Error('Result file write failed: '+f.error);}finally{f.close();}}\n` +
    `try{if(typeof app==='undefined'||!app.project||typeof CompItem==='undefined')throw new Error('Target is not After Effects');result.aeVersion=app.version;result.aeName=app.name||'Adobe After Effects';persist();` +
    (isolated ? `if(app.project.file||app.project.numItems!==0)throw new Error('Isolated helper must start with an empty project');app.exitAfterLaunchAndEval=true;` : '') +
    (undoGroup ? `app.beginUndoGroup(${JSON.stringify(undoGroup)});undo=true;` : '') +
    `result.stage='executing';persist();result.data=(function(){\n${code}\n})();result.success=true;result.stage='complete';}\n` +
    `catch(e){result.success=false;result.stage='failed';result.errors.push({message:String(e),line:e.line||null,file:e.fileName||null});}\n` +
    `finally{if(undo){try{app.endUndoGroup();}catch(e2){result.success=false;result.stage='failed';result.errors.push({message:String(e2)});}}result.finishedAt=(new Date()).getTime();try{persist();}catch(e3){result.success=false;result.stage='failed';result.errors.push({message:String(e3)});}}\nreturn encode(result);\n})()`;
}
const INSPECT = `var out={projectFile:app.project.file?app.project.file.fsName:null,numItems:app.project.numItems,activeItem:null,items:[],renderQueue:[],effects:null};
var limit=__LIMIT__, i, j, x, l, active=app.project.activeItem;
for(i=1;i<=Math.min(app.project.numItems,limit);i++){x=app.project.item(i);out.items.push({id:x.id,name:x.name,type:x.typeName,isComp:x instanceof CompItem});}
if(active instanceof CompItem){out.activeItem={id:active.id,name:active.name,width:active.width,height:active.height,frameRate:active.frameRate,duration:active.duration,time:active.time,numLayers:active.numLayers,layers:[]};
for(i=1;i<=Math.min(active.numLayers,limit);i++){l=active.layer(i);x={id:l.id||null,index:l.index,name:l.name,selected:l.selected,enabled:l.enabled,effects:[]};var fx=l.property('ADBE Effect Parade');if(fx){for(j=1;j<=Math.min(fx.numProperties,limit);j++){var p=fx.property(j);x.effects.push({name:p.name,matchName:p.matchName});}}out.activeItem.layers.push(x);}}
for(i=1;i<=Math.min(app.project.renderQueue.numItems,limit);i++){x=app.project.renderQueue.item(i);out.renderQueue.push({index:i,comp:x.comp.name,status:String(x.status)});}
if(__EFFECTS__){out.effects=[];var all=app.effects;for(i=0;i<all.length;i++)out.effects.push({displayName:all[i].displayName,matchName:all[i].matchName,version:all[i].version});}
return out;`;
async function executeJsx(a) {
  if ((!!a.code) === (!!a.scriptPath)) throw new Error('Supply exactly one of code or scriptPath');
  const mode = a.transport || 'cli';
  const isolated = a.launchMode === 'isolated';
  if (isolated && mode !== 'cli') throw new Error('launchMode isolated requires CLI transport');
  let launcher;
  if (mode === 'cli') {
    if (process.platform !== 'win32') throw new Error('Bundled CLI delivery currently supports Windows. Use CEP CDP on other hosts.');
    launcher = await executable(a.afterfxPath || process.env.AE_MCP_AFTERFX, /^AfterFX\.(exe|com)$/i);
  } else if (!Number.isSafeInteger(a.port) || !a.targetId) throw new Error('CDP requires port and exact targetId');
  let code = a.code;
  if (a.scriptPath) { const p = absolute(a.scriptPath, 'scriptPath'); await fs.access(p); code = 'return $.evalFile(new File(' + JSON.stringify(p.replace(/\\/g, '/')) + '));'; }
  const dir = await runDirectory(a), runId = path.basename(dir), resultPath = path.join(dir, 'host-result.json'), scriptPath = path.join(dir, 'probe.jsx');
  const wrapper = hostWrapper({ runId, code, resultPath: mode === 'cli' ? resultPath.replace(/\\/g, '/') : null, undoGroup: a.undoGroup, isolated });
  const launchArgs = mode === 'cli' ? [...(isolated ? ['-m', '-noui'] : []), '-r', scriptPath] : null;
  await fs.writeFile(scriptPath, wrapper, 'utf8');
  const startedAt = Date.now();
  await jsonWrite(path.join(dir, 'request.json'), { runId, transport: mode, launchMode: a.launchMode || 'existing', startedAt, scriptPath, resultPath, launcher, launchArgs, port: a.port, targetId: a.targetId });
  let payload;
  if (mode === 'cdp') {
    const expression = `new Promise(function(resolve,reject){if(!window.__adobe_cep__||typeof window.__adobe_cep__.evalScript!=='function'){reject(new Error('CEP host bridge unavailable'));return;}window.__adobe_cep__.evalScript(${JSON.stringify(wrapper)},function(v){resolve(v);});})`;
    try {
      const r = await cdpEvaluate({ ...a, expression });
      payload = JSON.parse(r.value); await jsonWrite(resultPath, payload);
    } catch (e) { throw new Error(e.message + '; probe=' + scriptPath + '; execution state may be unknown'); }
  } else {
    const stdout = await fs.open(path.join(dir, 'afterfx.stdout.log'), 'a');
    const stderr = await fs.open(path.join(dir, 'afterfx.stderr.log'), 'a');
    const child = spawn(launcher, launchArgs, { windowsHide: true, shell: false, stdio: ['ignore', stdout.fd, stderr.fd] });
    let launchError, exitCode = null;
    child.on('error', e => { launchError = e; }); child.on('exit', c => { exitCode = c; }); child.unref();
    await stdout.close(); await stderr.close();
    const deadline = startedAt + (a.timeoutMs || 30000);
    while (Date.now() < deadline) {
      if (launchError) throw new Error('AE delivery failed: ' + launchError.message + '; probe=' + scriptPath);
      try {
        const candidate = JSON.parse((await fs.readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''));
        if (candidate.runId === runId && ['complete', 'failed'].includes(candidate.stage)) { payload = candidate; break; }
      } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      await new Promise(r => setTimeout(r, 100));
    }
    await jsonWrite(path.join(dir, 'delivery.json'), { runId, launcherPid: child.pid, launcherExitCode: exitCode, resultProduced: !!payload });
    if (!payload) throw new Error('AE delivery timeout; execution may still be active. Do not retry mutations. Check AE readiness and file-write preference. result=' + resultPath);
  }
  if (payload.runId !== runId || !payload.aeVersion || !['complete', 'failed'].includes(payload.stage) || typeof payload.success !== 'boolean') throw new Error('Invalid/stale AE result: ' + resultPath);
  return { ...payload, resultPath, scriptPath, evidenceLevel: 'live-host', verifiedScope: 'This host invocation only; inspect returned assertions for feature correctness.' };
}
async function diagnostics(a) {
  if (process.platform !== 'win32') throw new Error('Bundled diagnostic collector requires Windows');
  const dir = await runDirectory(a), outputPath = path.join(dir, 'diagnostics.json');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'collect-adobe-debug-state.ps1'), '-OutputPath', outputPath];
  for (const [k, option] of [['repoPath', '-RepoPath'], ['extensionRoot', '-ExtensionRoot'], ['extensionId', '-ExtensionId'], ['since', '-Since']]) if (a[k]) args.push(option, a[k]);
  const r = await capture('powershell.exe', args, 45000);
  await jsonWrite(path.join(dir, 'collector-process.json'), r);
  if (r.exitCode !== 0) throw new Error('Collector failed: ' + r.stderr + '; evidence=' + dir);
  return { outputPath, evidenceLevel: 'diagnostic-inventory', data: JSON.parse((await fs.readFile(outputPath, 'utf8')).replace(/^\uFEFF/, '')) };
}
async function renderStart(a) {
  const aerender = await executable(a.aerenderPath || process.env.AE_MCP_AERENDER, /^aerender(\.exe)?$/i);
  const project = absolute(a.projectPath, 'projectPath'); await fs.access(project);
  if (!/\.aepx?$/i.test(project)) throw new Error('projectPath must be a saved .aep or .aepx');
  if (path.basename(a.outputName) !== a.outputName || /[/\\:]/.test(a.outputName) || ['.', '..'].includes(a.outputName)) throw new Error('outputName must be a filename or sequence pattern, without directories');
  if ((a.startFrame === undefined) !== (a.endFrame === undefined)) throw new Error('Specify both startFrame and endFrame');
  if (a.startFrame > a.endFrame) throw new Error('startFrame exceeds endFrame');
  const dir = await runDirectory(a), jobPath = path.join(dir, 'render-job.json');
  const args = ['-project', project, '-comp', a.comp, '-output', path.join(dir, a.outputName), '-close', 'DO_NOT_SAVE_CHANGES'];
  if (a.outputModule) args.push('-OMtemplate', a.outputModule);
  if (a.renderSettings) args.push('-RStemplate', a.renderSettings);
  if (a.startFrame !== undefined) args.push('-s', String(a.startFrame), '-e', String(a.endFrame));
  if (a.mfr) args.push('-mfr', a.mfr, String(a.maxCpuPercent || 50));
  await jsonWrite(jobPath, { schemaVersion: 1, runId: path.basename(dir), state: 'starting', startedAt: new Date().toISOString(), executable: aerender, args, outputName: a.outputName, outputDir: dir });
  const workerLog = await fs.open(path.join(dir, 'worker.log'), 'a');
  const worker = spawn(process.execPath, [SELF, '--render-worker', jobPath], { detached: true, windowsHide: true, stdio: ['ignore', workerLog.fd, workerLog.fd], shell: false });
  try { await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); }); worker.unref(); }
  finally { await workerLog.close(); }
  return { jobPath, workerPid: worker.pid, state: 'starting', outputDir: dir, nextTool: 'ae_render_status' };
}
async function renderWorker(jobPath) {
  const job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  const stdout = await fs.open(path.join(job.outputDir, 'aerender.stdout.log'), 'a');
  const stderr = await fs.open(path.join(job.outputDir, 'aerender.stderr.log'), 'a');
  let status;
  try {
    const child = spawn(job.executable, job.args, { windowsHide: true, shell: false, stdio: ['ignore', stdout.fd, stderr.fd] });
    const completion = new Promise(resolve => { child.once('error', e => resolve({ error: e.message, exitCode: null })); child.once('close', (code, signal) => resolve({ exitCode: code, signal })); });
    job.state = 'running'; job.workerPid = process.pid; job.aerenderPid = child.pid;
    await jsonWrite(jobPath, job);
    status = await completion;
  } catch (e) { status = { error: e.message, exitCode: null }; }
  finally { await stdout.close(); await stderr.close(); }
  const names = await fs.readdir(job.outputDir);
  const outputs = [];
  const pattern = new RegExp('^' + job.outputName.split(/(\[#+\])/).map(part => /^\[#+\]$/.test(part) ? '\\d{' + (part.length - 2) + ',}' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'i');
  for (const name of names.filter(x => pattern.test(x))) {
    const p = path.join(job.outputDir, name), stat = await fs.stat(p); if (stat.isFile()) outputs.push({ path: p, bytes: stat.size });
  }
  Object.assign(job, status, { outputs, finishedAt: new Date().toISOString(), state: status.exitCode === 0 && outputs.length && outputs.every(x => x.bytes > 0) ? 'complete' : 'failed', evidenceLevel: 'render-delivery', pixelCorrectnessVerified: false });
  await jsonWrite(jobPath, job);
}
export async function callTool(name, args = {}) {
  validate(name, args);
  switch (name) {
    case 'ae_discover': return discover(args);
    case 'ae_cep_targets': return { port: args.port, targets: await targets(args.port) };
    case 'ae_inspect_host': return executeJsx({ ...args, code: INSPECT.replace('__LIMIT__', String(args.maxItems || 100)).replace('__EFFECTS__', String(!!args.includeEffects)) });
    case 'ae_execute_jsx': return executeJsx(args);
    case 'ae_evaluate_panel': return cdpEvaluate(args);
    case 'ae_collect_diagnostics': return diagnostics(args);
    case 'ae_render_start': return renderStart(args);
    case 'ae_render_status': return JSON.parse(await fs.readFile(absolute(args.jobPath, 'jobPath'), 'utf8'));
  }
}
async function stdioServer() {
  let initialized = false;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const reply = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
  for await (const line of input) {
    let request;
    try { request = JSON.parse(line); } catch { reply({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || Array.isArray(request)) { reply({ id: request.id ?? null, error: { code: -32600, message: 'Invalid request' } }); continue; }
    if (!('id' in request)) continue;
    try {
      let result;
      if (request.method === 'initialize') {
        initialized = true;
        const requested = request.params?.protocolVersion;
        result = { protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ae-mcp', version: '1.1.0' },
          instructions: 'Control Adobe After Effects through JSX, CEP CDP and aerender without computer use. Discover exact executables and CEP target first. Preserve user projects and sessions. Timeout does not cancel a mutation; never blindly retry it. Use work/<task>/ for evidence. Report source, installed, loader, live-host and pixel/render proof separately. Execute destructive actions only within user authorization.' };
      } else if (request.method === 'ping') result = {};
      else if (!initialized) { reply({ id: request.id, error: { code: -32002, message: 'Initialize first' } }); continue; }
      else if (request.method === 'tools/list') result = { tools: TOOLS };
      else if (request.method === 'tools/call') {
        try { const data = await callTool(request.params?.name, request.params?.arguments || {}); result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: data.success === false || data.state === 'failed' }; }
        catch (e) { result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }], isError: true }; }
      } else { reply({ id: request.id, error: { code: -32601, message: 'Method not found' } }); continue; }
      reply({ id: request.id, result });
    } catch (e) { reply({ id: request.id, error: { code: -32603, message: e.message } }); }
  }
}
async function main() {
  if (process.argv[2] === '--render-worker') return renderWorker(process.argv[3]);
  if (process.argv[2] === '--call') {
    const name = process.argv[3], fileArg = process.argv.indexOf('--args-file');
    const args = fileArg === -1 ? {} : JSON.parse(await fs.readFile(process.argv[fileArg + 1], 'utf8'));
    const result = await callTool(name, args); process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.success === false || result.state === 'failed') process.exitCode = 1;
    return;
  }
  if (process.argv[2] && process.argv[2] !== '--stdio') throw new Error('Usage: node ae-mcp.mjs [--stdio | --call TOOL --args-file ABSOLUTE_JSON_PATH]');
  await stdioServer();
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
