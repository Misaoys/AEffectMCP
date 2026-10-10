# Bundled AE MCP transport and operations

## Installation and connection

The skill and MCP server are separate layers. Installing this skill provides instructions and executable helpers. Registering its stdio process exposes tools to the client after it loads that configuration. Confirm an actual initialization and `tools/list`; a config entry alone does not prove tools are available in the current chat.

Use Node 22+ with native `WebSocket` and `fetch`; the server has no npm dependencies and makes no external network requests. It uses newline-delimited JSON-RPC stdio, negotiates supported MCP versions (`2025-11-25`, `2025-06-18`, `2024-11-05`) and exposes tools. Stdout contains only protocol output.

Example Codex TOML (substitute the actual absolute executable and installed skill paths):

```toml
[mcp_servers.ae-mcp]
command = 'node'
args = ['C:/tools/ae-mcp/scripts/ae-mcp.mjs', '--stdio']
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
env_vars = ['ALLUSERSPROFILE', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'COMPUTERNAME', 'OS', 'ProgramData', 'ProgramFiles(x86)', 'ProgramW6432', 'PUBLIC', 'TMP', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'windir']
```

Optional environment keys: `AE_MCP_AFTERFX` and `AE_MCP_AERENDER` select executables; `AE_MCP_WORK_DIR` selects the task evidence root. Prefer explicit per-call paths when multiple versions or workspaces are involved. Without a work root the server uses `<process cwd>/work/ae-mcp`; when connected globally, supply the current task's absolute `workDir` on each file-producing call.

Forward the standard Windows system variables shown above when the client sanitizes its subprocess environment. A local A/B check with the official MCP SDK found that its default reduced environment did not produce an AE JSX result and left a render waiting; forwarding this system-only set restored a fresh isolated AE result. Passing the complete machine environment also allowed the full native-effect/render test to pass, but is not required by the supplied configuration. Passing only `TMP` did not restore delivery. Do not copy tokens or unrelated secrets into configuration; values for `env_vars` are inherited from the client.

An existing server with a different API should be used according to its own schemas. The tools below are names of this bundled implementation only.

## Tools

| Tool | Inputs and behavior |
| --- | --- |
| `ae_discover` | Optional absolute `roots` array. Searches root/direct AE install children; inventories running Windows hosts and common CEP roots, including installed `.debug` text. Does not recursively search the whole disk or scan ports. |
| `ae_cep_targets` | Explicit `port` from 1024 to 65534. Reads `http://127.0.0.1:<port>/json/list`; does not open a panel. |
| `ae_inspect_host` | Transport fields below; optional `maxItems` 1–500 and `includeEffects`. Read-only project inventory; no fixture creation. |
| `ae_execute_jsx` | Transport fields and exactly one of `code` or absolute `scriptPath`; optional `undoGroup`. `code` is a function body with a `return` value; files are evaluated with `$.evalFile`. Return plain JSON-compatible values without cycles or native AE object handles. |
| `ae_evaluate_panel` | `port`, exact `targetId`, `expression`, optional `timeoutMs`. `Runtime.evaluate` with return-by-value and awaitPromise. Arbitrary expressions can mutate the panel/host: inspect first and stay within the user's requested action. |
| `ae_collect_diagnostics` | Optional `repoPath`, `extensionRoot`, `extensionId`, ISO `since`, and `workDir`. Runs the bundled Windows PowerShell collector and retains output/process evidence. |
| `ae_render_start` | Absolute saved `projectPath`, explicit `comp`, `outputName` filename/sequence pattern, absolute `aerenderPath` or env, `workDir`. Optional `outputModule`, `renderSettings`, paired `startFrame`/`endFrame`, `mfr` ON/OFF, `maxCpuPercent`. Returns `jobPath` immediately. Uses no `-reuse`, writes a unique output directory and closes its task project without saving. |
| `ae_render_status` | Absolute `jobPath` from the start call. Reads persisted state, logs, executable/args, exit code and output inventory. Timeout/no worker completion does not imply pixel correctness or justify a broad process kill. |

Transport fields: `transport` is `cli` (default) or `cdp`; `afterfxPath` is required for CLI unless supplied in env; CDP requires an explicit `port` and exact `targetId`. CLI `launchMode` is `existing` (default) or `isolated`. `workDir` is an absolute task directory. `timeoutMs` ranges 100–55000 and defaults to 30000. A timeout stops waiting, not the AE operation.

## Programmatic entry paths

Default AfterFX CLI delivery uses the Adobe `-r` command with a generated absolute `.jsx` and preserves the regular host lifecycle. For task-owned fixtures use `launchMode="isolated"`, which invokes `-m -noui -r` and enables `app.exitAfterLaunchAndEval` after verifying an empty initial project. The isolated mode was tested on this machine with AE 25.5x4; validate other installed versions before claiming equivalent behavior. It cannot inspect the user's open project or prove panel/ScriptUI presentation. Do not infer a recovery dialog from a stale loader log alone. In a local control comparison the regular hidden startup did not execute the script, while an independent no-UI helper returned fresh data and exited zero.

The wrapper writes starting/executing/final progress; a fresh final payload with current run id and AE version is required. File-write preferences may block result output; do not silently change preferences or interpret absent output as a feature failure. Never add automatic fallback from an unknown timed-out mutation to a new isolated execution.

CDP attaches only to the supplied loopback CEP target, evaluates a Promise around `window.__adobe_cep__.evalScript`, validates host identity/version/run id and writes the callback result using Node. That transport avoids the host file-write requirement for inline-code results; code/file operations that themselves write still need applicable permissions. Old CEP protocol engines may not support `awaitPromise`; report that incompatibility and use the CLI or a repository-proven bridge.

Both transports check for an AE project API and `CompItem` before user code. CEP title/URL alone is insufficient host proof. No code is evaluated in a remote endpoint. Windows paths, JSX strings and CDP expressions cross boundaries through argument arrays/JSON string serialization, never shell-built strings.

## CLI fallback example

Write the JSON below as `<task>/work/ae-mcp/inspect-args.json`, replacing paths with verified absolute paths:

```json
{
  "transport": "cli",
  "launchMode": "isolated",
  "afterfxPath": "E:/Adobe/Adobe After Effects 2025/Support Files/AfterFX.exe",
  "workDir": "E:/project/work/ae-mcp",
  "includeEffects": true,
  "timeoutMs": 30000
}
```

Then invoke the installed skill without embedding arguments into shell code:

```powershell
& node 'C:/tools/ae-mcp/scripts/ae-mcp.mjs' --call ae_inspect_host --args-file 'E:\project\work\ae-mcp\inspect-args.json'
```

For an authorized edit, use `ae_execute_jsx` with a function body and optional undo group. Read-only layer/property inspection is a useful first step:

```javascript
var comp = app.project.activeItem;
if (!(comp instanceof CompItem)) throw new Error('Select the intended comp');
var result = [];
for (var i = 1; i <= comp.numLayers; i++) {
  var layer = comp.layer(i);
  result.push({id: layer.id || null, index: layer.index, name: layer.name});
}
return {compId: comp.id, layers: result};
```

For native testing, create a task-owned fixture through JSX, add the actual effect match name, assert parameters, save a separate fixture project, render selected frames with `ae_render_start`, poll status and compare decoded pixels/alpha against the required expected behavior. No generic test fixture should overwrite a user's project.

Output templates can carry a previously used output directory. After applying a template, inspect its actual settings and explicitly supply the task-owned output path; the render tool always uses `-output` for its unique directory. Interpret decoded pixels using those settings. A tested AE TIFF template reported RGB + Alpha, Premultiplied (Matted), Millions of Colors+ and TIFF Sequence; its 8-bit samples used adjacent quantization levels. The TIFF marked its fourth sample with `ExtraSamples=0`, so retain all four raw samples with a decoder such as tifffile rather than allowing a generic image loader to discard alpha.

## Maintenance and honest coverage

Run `node --check scripts/ae-mcp.mjs`, `node --test scripts/test-ae-mcp.mjs` and the original collector regression after changing those helpers. Tests use protocol/transport fixtures and a fake ExtendScript host; they are source/harness proof, not real Adobe execution. Add live-host and render evidence only when the actual installed host is available.

This implementation exposes scriptable control, panel runtime access, diagnostics and render jobs. It does not implement a native debugger, recover modal dialogs, install missing AE, expose every UI-only command or prove all third-party effect behavior. Use repository-native SDK/build/debug facilities for AEX breakpoints/crashes. Do not switch to computer use without a new explicit request.

Primary sources:

- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), [lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).
- [Adobe scripting, permissions and AfterFX -r](https://helpx.adobe.com/after-effects/using/scripts.html).
- [Adobe automated rendering and aerender process behavior](https://helpx.adobe.com/after-effects/using/automated-rendering-network-rendering.html).
- [Adobe CEP cookbook: remote debugging and evalScript](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md).
- [Official Codex MCP configuration](https://developers.openai.com/codex/mcp).
