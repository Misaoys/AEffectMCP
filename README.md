<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img alt="AEffectMCP — Connect your agent to your craft. MCP · JSX · CEP · aerender." src="assets/banner-light.svg" width="1200">
</picture>

<p>
  <a href="LICENSE"><img alt="MIT license" src="assets/badge-license.svg"></a>
  <img alt="Node.js 22+" src="assets/badge-node.svg">
  <img alt="8 MCP tools" src="assets/badge-tools.svg">
  <img alt="Version 1.1" src="assets/badge-version.svg">
</p>

[English](README.md) · [中文说明](README.zh-CN.md)

**AEffectMCP** connects programmatic tools to the real After Effects host, with structured results and render evidence.

Control, debug and test Adobe After Effects through MCP, JSX, CEP bridges and aerender, without computer use. Includes a local stdio MCP server and an optional Codex skill.

The server has **zero npm dependencies**. Node.js 22 or newer is required. After Effects must already be installed.

**Real host access** — JSX execution and CEP scripting bridges.<br>
**Clear evidence** — Diagnostics, assertions and independent render jobs.

## Tools

| Tool | Purpose |
| --- | --- |
| `ae_discover` | Find AE executables, running Windows hosts and installed CEP roots |
| `ae_cep_targets` | List targets on an explicit local CEP debug port |
| `ae_inspect_host` | Read AE version, project, comp/layers, render queue and optional effect registry |
| `ae_execute_jsx` | Run a JSX function body or script file through AfterFX or a real CEP bridge |
| `ae_evaluate_panel` | Inspect or operate a CEP panel's DOM/runtime through CDP |
| `ae_collect_diagnostics` | Collect Windows manifest, installation and log evidence |
| `ae_render_start` | Start a separate aerender job with a unique output directory |
| `ae_render_status` | Read job status, exit code, logs and output inventory |

## Quick start

```sh
git clone https://github.com/Misaoys/AEffectMCP.git
cd AEffectMCP
node scripts/ae-mcp.mjs --call ae_discover
```

To run the MCP server:

```sh
node scripts/ae-mcp.mjs --stdio
```

Stdout is reserved for MCP JSON-RPC. Do not paste interactive commands into the server's stdin.

### Connect to Codex

Add the following to your MCP configuration. Replace the repository and executable paths with paths verified on your machine. Windows paths can use forward slashes in TOML.

```toml
[mcp_servers.ae-mcp]
command = 'node'
args = ['C:/tools/AEffectMCP/scripts/ae-mcp.mjs', '--stdio']
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
env_vars = ['ALLUSERSPROFILE', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'COMPUTERNAME', 'OS', 'ProgramData', 'ProgramFiles(x86)', 'ProgramW6432', 'PUBLIC', 'TMP', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'windir']

[mcp_servers.ae-mcp.env]
AE_MCP_AFTERFX = 'C:/Program Files/Adobe/Adobe After Effects 2025/Support Files/AfterFX.com'
AE_MCP_AERENDER = 'C:/Program Files/Adobe/Adobe After Effects 2025/Support Files/aerender.exe'
```

Reconnect your MCP client and confirm that it lists the eight tools. Installing the skill alone does not register the server.

The Windows environment forwarding above was verified with the official MCP SDK. Its default reduced environment did not deliver an AE result on the tested machine; the supplied system-only set restored the full host/render flow. Other clients should preserve the corresponding system variables without forwarding unrelated credentials.

### Optional Codex skill

Clone this repository into your Codex skills directory under the name `ae-mcp`, or copy the repository's `SKILL.md`, `agents/`, `references/` and `scripts/` into that directory. Then use `$ae-mcp`. Keep the MCP command pointed at the actual installed script location.

The project is named AEffectMCP. The `ae-mcp` skill/config key, script filename and existing `ae_*` tools remain compatible with previous installations.

## Run an isolated AE probe

Create an arguments file outside the source tree's tracked files:

```json
{
  "launchMode": "isolated",
  "afterfxPath": "C:/Program Files/Adobe/Adobe After Effects 2025/Support Files/AfterFX.com",
  "workDir": "C:/projects/my-project/work/ae-mcp",
  "timeoutMs": 55000
}
```

```sh
node scripts/ae-mcp.mjs --call ae_inspect_host --args-file C:/projects/my-project/work/inspect-args.json
```

`isolated` uses `-m -noui -r`, checks for an empty initial project and asks the owned helper to exit after evaluation. It does not read the user's current project or prove visible panel behavior. The default `existing` mode uses the regular host. CDP attaches to a selected real CEP target and calls the Adobe `evalScript` bridge.

For an edit, use `ae_execute_jsx` with exactly one of `code` or an absolute `scriptPath`. `code` is a function body returning JSON-compatible data; `undoGroup` optionally groups reversible edits. Always assert the actual postconditions. Arbitrary JSX and panel expressions can modify projects/files: they are not sandboxed.

Supply an absolute task-owned `workDir` for file-producing calls. An execution timeout stops waiting; it does **not** cancel an AE operation. Inspect the result and project state before retrying a mutation.

Read [the transport and tool reference](references/mcp-control.md) for schemas, render jobs, diagnostics and more examples.

## Verification and limits

- 13 Node regression tests cover JSON serialization, host checks, isolated helper ownership, MCP protocol, CDP callbacks/errors/timeouts and asynchronous render failure reporting.
- The PowerShell collector has 10 regression scenarios for manifest/resources, path containment, debug ports and installed-file parity.
- A Windows AE 25.5x4 test through the official MCP SDK verified compositions, layers, keyframes, expressions, markers, reopening a saved test project and the native `ADBE Fill` effect.
- An actual aerender job produced 25 frames of 64×64 RGBA TIFF. All 409,600 decoded samples matched the analytical premultiplied color/opacity expectation at the adjacent 8-bit quantization levels.

CI tests use fixtures and do not install or run Adobe software. Real CEP panel/CDP behavior, visible ScriptUI, third-party AEX effects, MFR, GPU backends and other host/version combinations require their own live tests. The bundled AfterFX CLI and PowerShell diagnostics support Windows; other platforms may use a compatible exposed CEP endpoint. macOS has not been validated.

Source, build, package, installed-file parity, loader recognition and actual host/render evidence are distinct. See [the evidence ladder](references/evidence-ladder.md).

## Development

```sh
npm test
```

On Windows:

```powershell
npm run test:collector
```

No `npm install` is required. Test artifacts belong under `work/` and are ignored by Git. Never submit host logs, saved projects, rendered frames or credentials with an issue; provide a redacted scenario and relevant error details.

## License

[MIT](LICENSE). Adobe After Effects and Adobe SDK/runtime components are not included. This project is not affiliated with Adobe.
