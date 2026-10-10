# CEP Runtime, Bridge, and Install Parity

## Determine the Actual Runtime

Read the installed CSXS/manifest.xml and the target host version before choosing browser compatibility rules. The CEP cookbook maps CEP releases to different CEF/Chromium generations; use the repository's declared host range rather than assuming the newest browser APIs are present.

Record:

- Extension id, MainPath, host names/ranges, and required CSXS runtime.
- Actual installed extension root and the file that loaded the changed client or host code.
- Target host version, OS, and development versus signed/distributed installation mode.

Keep panel JavaScript, CSS, and build transforms within the oldest supported runtime. Do not use a successful modern browser test as evidence of CEP compatibility.

## Manifest Resource Contract

Treat ExtensionList, DispatchInfoList, MainPath, and ScriptPath as one deployment contract:

1. Match every declared extension id to one DispatchInfo entry; flag missing, orphaned, or duplicate DispatchInfo ids.
2. Resolve MainPath and ScriptPath from the installed extension root, not from the source checkout.
3. Require local resource paths to remain inside that root. A relative path containing traversal can load an unintended file or hide a packaging error.
4. Record whether each local resource exists and retain its SHA-256 only as delivery evidence.
5. Treat absolute URIs separately. They do not prove a packaged local resource is present.

Use the collector's manifestContract and extensionContract output to make these checks machine-readable. A passing resource contract proves configuration and file delivery, not that CEP rendered the panel or executed JSX.

## Development Debug State

Use .debug only for the installed development extension root:

1. Match its Extension Id to the manifest extension id.
2. Map the target host to the intended port and verify the port is usable before attaching a browser.
3. Check PlayerDebugMode and LogLevel under the CSXS major that matches the target runtime.
4. Restart the host if the configured debug/log setting requires it; do not change a user's registry state unless the task authorizes it.
5. Capture logs fresh relative to the current run.

The bundled collector reports the manifest, .debug mappings, relevant registry values, file fingerprints, recent logs, and an optional freshness boundary. It is read-only except for an explicitly requested JSON OutputPath. Use SkipLogDiscovery only for a synthetic/static test where recursive user-log discovery adds no evidence; never use it to diagnose a live CEP failure.

## Bridge Contract

Exercise CSInterface.evalScript or the underlying bridge from a real CEP panel. A standalone browser can unit-test encoding and UI code but cannot create the Adobe host bridge object.

For each nontrivial bridge request:

- Give the request a token or run identifier.
- Serialize arguments with a project-compatible escaping boundary.
- Assert callback invocation, decoded result shape, and host-side result freshness.
- Distinguish a transport timeout, a host exception/result, and a panel callback failure.
- Avoid treating a truthy string or absent callback as a successful host operation.

Use the JSX result-file contract for host-side operations, particularly when the panel callback cannot expose enough diagnostic detail.

## Cache and Delivery Parity

Use the project's own sync/install path. Then compare source and installed files by content or SHA-256 before investigating behavior.

Pass only the changed relative paths to CompareRelativePath. The collector rejects rooted or escaping paths and reports match, mismatch, missing-source, missing-target, or invalid-path instead of inferring parity from a sync summary. When more than one path is needed, invoke the collector from a PowerShell command block with an explicit array; Windows PowerShell does not reliably pass a string array through powershell.exe -File.

If a panel loads scripts with query-string or build-version cache keys:

1. Update every changed CEP-loaded script's key according to the repository convention.
2. Confirm the deployed HTML references the new keys.
3. Confirm the installed client and host files contain the intended repair.
4. Open the target panel and capture fresh log or probe evidence.

A sync success line, an unchanged source timestamp, or a browser reload does not prove the host used the deployed code.

## Fresh Log Triage

Inspect CEPHtmlEngine and PlugPlug logs in timestamp order:

- Panel boot: manifest/MainPath, signature/debug state, CEF load, CSP, and JavaScript startup errors.
- Bridge call: extension id, host context, evaluated script, callback/result, and host-side output.
- Installed-user report: source-versus-installed parity before feature diagnosis.

Do not raise LogLevel globally or delete log files just to simplify inspection. Preserve a small time-bounded evidence set for the current run.
