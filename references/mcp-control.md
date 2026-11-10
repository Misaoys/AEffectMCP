# AEffectMCP transport and operations

## Installation and connection

The skill and MCP server are separate layers. Installing this skill provides instructions and executable helpers. Registering its stdio process exposes tools to the client after it loads that configuration. Confirm an actual initialization and `tools/list`; a config entry alone does not prove tools are available in the current chat.

Use Node 22+ with native `WebSocket` and `fetch`; the server has no npm dependencies and makes no external network requests. It uses newline-delimited JSON-RPC stdio, negotiates supported MCP versions (`2025-11-25`, `2025-06-18`, `2024-11-05`) and exposes tools. Stdout contains only protocol output.

Example Codex TOML (substitute the actual absolute executable and installed skill paths):

```toml
[mcp_servers.ae-mcp]
command = 'node'
args = ['C:/tools/AEffectMCP/scripts/ae-mcp.mjs', '--stdio']
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
| `ae_discover` | Optional absolute `roots` array. Searches root/direct AE install children and macOS AE application bundles for aerender; inventories running Windows hosts and common CEP roots, including installed `.debug` text. Does not recursively search the whole disk or scan ports. macOS bundle discovery still needs verification on a real Mac. |
| `ae_cep_targets` | Explicit `port` from 1024 to 65534. Reads `http://127.0.0.1:<port>/json/list`; does not open a panel. |
| `ae_inspect_host` | Transport fields below; optional `maxItems` 1–500 and `includeEffects`. Read-only project inventory; no fixture creation. |
| `ae_execute_jsx` | Transport fields and exactly one of `code` or absolute `scriptPath`; optional `undoGroup` and `verifyCode`. The latter is an ES3 function body that checks actual host state and must return exactly `true`; otherwise the invocation fails. Without it, `verificationStatus` is `not_requested` and feature behavior remains unverified. `code` is a function body with a `return` value; files are evaluated with `$.evalFile`. Return plain JSON-compatible values without cycles or native AE object handles. |
| `ae_collab_create` | Create a disposable shared AEP in a managed session using an isolated AE helper. Optional absolute `sourceProjectPath` snapshots an existing saved AEP/AEPX, checks source/copy hashes and source metadata, and opens only the copy to inventory compositions and missing footage. Returns `sessionId`, copy `projectPath`, source SHA-256, comp names/IDs and missing footage. The snapshot contains only the saved disk version. Windows AE CLI only. |
| `ae_collab_claim` / `ae_collab_release` | Exclusively claim a comp for an `agentId`, and release it for handoff. Supply `compId` with `compName` for duplicate names; stable IDs are retained across handoffs. Existing-project sessions accept only comps in their inventory. |
| `ae_collab_run` | Under a cross-process project lock, open the shared AEP in an isolated helper, find or create the claimed `comp`, execute `code`, require `verifyCode` to return `true`, then save. New comps default to 512×512, five seconds and 30 fps; width, height, duration and frameRate are adjustable. Both function bodies receive `comp`; arbitrary JSX is not sandboxed. |
| `ae_collab_note` / `ae_collab_status` | Share short notes and inspect claims, registered comp IDs, last commit and lock state. Notes are limited to 100 per session. |
| `ae_collab_close` | Close an unlocked session after all claims are released; it can then be previewed/deleted by the managed cleanup tool. |
| `ae_collab_resolve` | Manual recovery only: after independently confirming **all** helpers stopped and inspecting the saved AEP, supply `agentId`, `reason`, `confirmHelperStopped: true` and `acceptSavedProject: true`. Never auto-resolve or break an active lock. Initialization failures resolve to a closed session. |
| `ae_test_session_create` | Creates a marked disposable session in the OS temp directory; returns `sessionDir` and `projectPath`. Create new test projects at `projectPath`, pass `sessionDir` as `workDir`, and preserve wanted deliverables elsewhere. |
| `ae_test_cleanup` | Windows PowerShell previews managed sessions by default; set `delete: true` for one-click cleanup, or additionally specify `sessionId`. Skips reparse points and pending/unknown runs. It does not close projects, clean legacy paths, or protect a session concurrently used by another client; only clean after use has stopped. |
| `ae_jsx_status` | Inspect a prior CLI `host-result.json` after a timeout; CDP timeouts have no late result file. Missing, partial, or nonterminal results are unknown, not cancelled; do not automatically retry. |
| `ae_evaluate_panel` | `port`, exact `targetId`, `expression`, optional `timeoutMs`. `Runtime.evaluate` with return-by-value and awaitPromise. Arbitrary expressions can mutate the panel/host: inspect first and stay within the user's requested action. |
| `ae_collect_diagnostics` | Optional `repoPath`, `extensionRoot`, `extensionId`, ISO `since`, and `workDir`. Runs the bundled Windows PowerShell collector and retains output/process evidence. |
| `ae_render_start` | Absolute saved `projectPath`, explicit `comp`, `outputName` filename/sequence pattern, absolute `aerenderPath` or env, `workDir`. Internal job and log filenames are reserved and excluded from output inventory. Optional `outputModule`, `renderSettings`, paired `startFrame`/`endFrame`, `mfr` ON/OFF, `maxCpuPercent`. Returns `jobPath` immediately. Uses no `-reuse`, writes a unique output directory and closes its task project without saving. |
| `ae_render_status` | Absolute `jobPath` from the start call. Reads persisted state, logs, executable/args, exit code and output inventory. Timeout/no worker completion does not imply pixel correctness or justify a broad process kill. |

Transport fields: `transport` is `cli` (default) or `cdp`; `afterfxPath` is required for CLI unless supplied in env; CDP requires an explicit `port` and exact `targetId`. CLI `launchMode` is `existing` (default) or `isolated`. `workDir` is an absolute task directory. `timeoutMs` ranges 100–55000 and defaults to 30000. A timeout stops waiting, not the AE operation.

The stdio server handles ping, tool listing and render-status reads while another tool call waits. Other tool calls are queued. Queueing covers the request lifetime only: a timed-out host operation may still be running, so inspect its state before issuing another host mutation.

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
& node 'C:/tools/AEffectMCP/scripts/ae-mcp.mjs' --call ae_inspect_host --args-file 'E:\project\work\ae-mcp\inspect-args.json'
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

## Multiple agents sharing a test AEP

1. Call `ae_collab_create`; for an existing saved project, provide its absolute `sourceProjectPath` to create a verified, temporary copy. Omit it to create a blank test project. Distribute the returned `sessionId` and composition inventory to participants. The source is never opened or saved by the collaboration workflow; only its saved on-disk state is copied.
2. Each agent calls `ae_collab_claim` with its `agentId` and `compName`; if names are duplicated, also pass the selected `compId` to claim, run and release. Handoffs require release and a new claim. `ae_collab_status` and `ae_collab_note` provide shared coordination.
3. Agents use `ae_collab_run` with `code` and `verifyCode`. Example: `code: "comp.layers.addNull().name='Marker'; return comp.numLayers;"` and `verifyCode: "return comp.layer(1).name==='Marker';"`. The helper opens the same saved AEP, verifies, and saves before releasing the cross-process lock. Busy responses mean no operation started and may be retried; after a timeout or failed operation, do not retry or clear the lock automatically.
4. Release all claims, call `ae_collab_close`, preserve wanted artifacts elsewhere, then use `ae_test_cleanup`.

These are cooperative controls, not authorization or a security sandbox. Arbitrary JSX, `ae_execute_jsx`, an older MCP server, or external AE processes can bypass claims or call `save` directly. All writers must use the collaboration tools, and no other AE process should open or edit the project during the session. Work is serialized, not simultaneous live editing. Only the isolated Windows CLI workflow has live-host evidence; other versions and platforms require their own verification. Render jobs must be scheduled after writes complete; the collaboration lock does not cover `ae_render_start`.

Existing-project sessions copy only the AEP/AEPX file. Media, fonts, plugins and linked files remain external and may be missing or change; inspect `missingFootageCount` and `missingFootage` before testing. Project copying does not include unsaved AE state or sandbox arbitrary JSX/plugins; external code can still write to the source or its linked assets. Source snapshot checks detect changes during copying, not later user edits. Export wanted results explicitly from the copy; there is no automatic write-back. AEPX and missing-footage behavior need separate live-host verification.
