# Adobe Extension Evidence Ladder

## Rule

Name the strongest evidence actually collected, not the evidence that would be convenient to infer. A later layer can depend on earlier layers; an earlier layer never proves a later one.

## Evidence Levels

| Level | What it proves | What it does not prove |
| --- | --- | --- |
| Source | A code, syntax, static, or focused regression contract holds in the checkout. | The host bundle was delivered, a package includes it, or Adobe executed it. |
| Build | The configured project generated an artifact. | The target host finds, loads, or renders the artifact. |
| Loader | The installed AEX artifact is recognized by the target host loader. | Parameters, rendering, MFR, and user-visible behavior work. |
| Package | The extracted distributable contains the intended files and metadata. | The installer chose the right target or a live host used them. |
| Installed | The target CEP/plugin installation contains the expected content or SHA-256. | The panel/host loaded the content or the result is correct. |
| Live host | A fresh real CEP/AE result, log, or render proves the named scenario. | Untested hosts, versions, architectures, or release packaging. |
| Release | Applicable package, install, and live-host gates pass for the intended distribution path. | Future remote or clean-machine conditions not included in the test. |

## Required Ledger

For every material verification, record:

- Scenario and expected assertion.
- Exact command and exit code.
- Start time, end time, host/runtime version, and target path.
- Result JSON or log path and its freshness evidence.
- Evidence level reached and the next unverified level.

Use the following language in reports:

- "Source contract verified; installed and live-host behavior not yet checked."
- "Installed parity verified; no live CEP/AE execution evidence was collected."
- "Plugin loader verified; rendering and MFR behavior remain unverified."
- "Live host behavior verified for AE 25.x on this machine and scenario."
- "Blocked at host delivery: a result file was not produced, so host logic is not classified."

## Gate Selection

| Change surface | Minimum useful gates | Add these before calling it complete |
| --- | --- | --- |
| CEP UI-only source fix | Source | Installed parity for installed-user reports; live CEP panel result for behavior claims |
| CEP-to-JSX bridge | Source and live panel callback | Installed host bundle parity and fresh host-side result |
| JSX host behavior | Source and syntax-style gate | Fresh AE result file that checks actual project state |
| AEX parameter/resource fix | Source, build, loader | Minimal real render/sample and installed binary identity |
| AEX MFR claim | Source, build, loader | PiPL/source flag parity, thread/sequence-state review, and applicable real concurrent-render evidence |
| Installer/package change | Source and package | Installed target parity and applicable live CEP/AE smoke gate |

## Blocked Environments

Classify the blocker instead of silently weakening the claim:

- A command-line AE probe that times out at launch is delivery/harness evidence until a control or live panel session separates transport from host logic.
- A lock, ACL, or elevation mismatch can block installed-file inspection without proving sync failure. Re-run the narrow inspection in the matching context when safe.
- A stale installed file invalidates feature diagnosis. Fix delivery first.
- A crash warning in an unrelated log is not a crash report. Use a dump, Windows event, reproducible fault, or equivalent host evidence.

## Release Integrity

For distribution work, compare the named files across source, extracted package, and installed target. Audit recursive packaging inputs for temporary directories, caches, dependencies, generated build output, and unapproved files. Treat a tool's "success" summary as a signal to inspect the intended artifact, not as the artifact proof itself.
