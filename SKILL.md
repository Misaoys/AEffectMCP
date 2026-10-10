---
name: ae-mcp
description: "Control, debug and test Adobe After Effects through MCP, ExtendScript/JSX, CEP script bridges and aerender without computer use. Covers projects, compositions, layers, keyframes, expressions, CEP/ScriptUI and AEX/PiPL plugins with separate source, installed, loader and live-host evidence."
---

# AE MCP

Use programmatic AE interfaces for the requested work. This skill includes an actual local stdio MCP server, not merely a prompt or a claim that AE tools are already connected. The bundled implementation requires Node 22+ with native WebSocket and fetch. Windows supports AfterFX CLI and diagnostics; CEP CDP works wherever the host exposes a compatible debug endpoint. aerender requires its installed executable.

## Choose the available transport

1. Discover exposed AE MCP tools and inspect their actual schemas. Prefer a connected AE server when its capabilities fit. Do not invent tool names for a third-party server.
2. For the bundled server, use `ae_discover`, then choose the exact executable/version or installed CEP `.debug` mapping. Custom installation roots can be passed to discovery; a missing default path is not proof AE is absent.
3. Use an existing real CEP target for panel/bridge work: `ae_cep_targets` lists an explicit loopback port, `ae_evaluate_panel` accesses the panel runtime, and JSX with `transport="cdp"` calls the actual Adobe bridge. Select by installed extension URL and exact target id; do not select the first arbitrary browser tab.
4. Without a ready CEP target, Windows JSX uses the absolute `AfterFX.exe` or `AfterFX.com` path with `-r`. Default `launchMode="existing"` targets the regular host and preserves its lifecycle. For an isolated script/render fixture, set `launchMode="isolated"`: the helper uses `-m -noui -r`, requires an empty initial project and sets `app.exitAfterLaunchAndEval=true` for its owned instance. This mode cannot observe the user's current project or test visible ScriptUI/panel behavior. A fresh result file, not launcher exit or a timeout, proves execution; startup state and script file-write preferences can still block delivery.
5. Use `ae_render_start` and `ae_render_status` for a saved project and explicit comp. Jobs run separately from the user host, return immediately and retain logs, exit code and output inventory.
6. If MCP tools have not loaded into the current chat, run the same bundled tools through `node <skill>/scripts/ae-mcp.mjs --call <tool> --args-file <absolute-json-path>`. Store arguments and evidence in `work/<task>/`. This fallback invokes the same implementation; it does not require computer use.

Read [references/mcp-control.md](references/mcp-control.md) for setup, schemas, transport requirements and examples. Do not invoke or load computer-use workflows for AE control. If a capability is inaccessible through scripting, CDP, rendering or a project-specific native bridge, report that exact boundary and continue the remaining programmatic work.

When a direct CLI probe works but the MCP-launched equivalent exits without a result, inspect the client's inherited system environment. The bundled configuration forwards a tested set of standard Windows variables; avoid forwarding unrelated tokens or treating protocol connection success as host delivery proof.

## Control and inspect AE

- Start with `ae_inspect_host` to establish real host version, project, active comp, stable item/layer identifiers, render queue and optional effect registry. Read-only inspection writes task evidence without modifying the project.
- `ae_execute_jsx` accepts a function body returning JSON-compatible data, or an absolute `.jsx`/`.jsxbin` file through `$.evalFile`. Arbitrary scripts can mutate project/files; match their effects to the user's requested action. The tool is not a sandbox or an approval bypass.
- Use host APIs for comp/layer creation, selected items, transforms, effects, keyframes, expressions, markers, imports and render queue setup. Match names and item/layer ids take priority over localized labels and positional guesses. Inspect the target property tree when its contract is uncertain.
- Return explicit postcondition assertions. For expressions, check `expressionError` and sampled values at relevant times. For markers, check time/duration/text on the correct marker property. For effect writeback, assert target/source identity and relative layer placement.
- Group authorized reversible edits with `undoGroup`. An undo group is not an automatic rollback. Avoid closing, replacing, saving over or clearing the user's current project when an isolated task-owned comp or project copy suffices.
- A render/probe fixture must be isolated and named for the current run. Opening a different project or modifying the user's render queue requires a task reason and existing authorization. Do not start broad cleanup or terminate unowned hosts/helpers.
- Do not retry a mutation after a transport timeout. It may still run on AE's main thread. Inspect the current run's result/state first; distinguish unknown delivery from a known host exception. Fix the transport and rerun only after proving the prior operation did not run or that retry is safe.

## Debug and verify

Read the repository's current `AGENTS.md` and applicable project guidance. Preserve its build/sync/package contracts and supported CEP/ExtendScript baseline. Update durable project knowledge only when authorized.

Identify the failing layer before edits:

| Surface | Programmatic evidence | Relevant reference |
| --- | --- | --- |
| CEP startup/UI | Installed manifest/resources, `.debug`, fresh logs, CDP DOM/runtime and authorized DOM events | [cep-runtime.md](references/cep-runtime.md) |
| CEP to JSX | Real panel `evalScript` callback, correct serialization, host version and fresh run id | [probe-patterns.md](references/probe-patterns.md) |
| JSX/ScriptUI | ExtendScript execution, actual project state and named assertions; avoid interactive dialogs in probes | [probe-patterns.md](references/probe-patterns.md) |
| AEX/native | Build, exact installed binary, fresh loader evidence, stable effect match name, real render/sample | [aex-lifecycle.md](references/aex-lifecycle.md) |
| Distribution | Source, extracted package, installed files and metadata match applicable delivery contract | [evidence-ladder.md](references/evidence-ladder.md) |

The bundled `ae_collect_diagnostics` wraps the original read-only collector for manifest, install parity, registry and log inventory. It does not start AE or prove a host call. The existing collector regression script remains available; run it after changing the collector.

For native effects, preserve parameter order/count, compatibility identifiers, PiPL/resource parity, checkout/checkin symmetry and sequence-data ownership. Applying an effect or finding `app.effects` proves availability in that host, not correct rendering or MFR. Test those claims using real output and SDK contracts. Use a pixel/frame comparison suited to the format, including alpha interpretation; a digest cannot establish image correctness.

For CEP host entry points, verify the project's actual registration and host-bundle loading path; probe only after panel readiness and applicable authorization recovery. Browser mocks do not prove a host bridge.

## Evidence and reporting

Read [references/evidence-ladder.md](references/evidence-ladder.md) before declaring verification. Keep source, build, package, installed, loader, live host and release claims distinct. aerender exit zero plus nonempty output is render delivery evidence; assertions or direct pixel comparisons establish the behavior being tested.

Retain current run id, exact executable/version and command, timestamp, exit code, result/log paths and assertion outcomes. Write temporary scripts, logs, JSON, fixtures, builds and test renders under the task's `work/<task>/`, not visualization directories. Expose only useful deliverables to the user.

Report the strongest collected evidence and the precise remaining boundary. A missing result, locked installation, absent CEP endpoint or unavailable scripting preference is a transport/environment finding until stronger evidence identifies a feature defect. AEX startup warnings alone are not proof of a native crash; inspect actual fault/dump evidence.

Use [references/official-sources.md](references/official-sources.md) when version-sensitive scripting, CEP or native SDK behavior needs verification.
