# JSX Probe Patterns

## Result-File Contract

Write a result file for every nontrivial probe. Use a unique run directory or run identifier so an old successful file cannot satisfy a new test.

~~~
{
  "schemaVersion": 1,
  "runId": "20260807T164500Z-layer-placement",
  "success": false,
  "scenario": "layer-placement",
  "stage": "starting",
  "startedAt": "2026-08-07T16:45:00Z",
  "finishedAt": null,
  "aeVersion": null,
  "checks": [],
  "errors": []
}
~~~

Update stage and write partial progress before a long or failure-prone host call. Set success and finishedAt only after all required checks pass. Keep absolute file paths, tokens, user media names, and other sensitive data out of result payloads unless they are needed for the assertion.

Use a project-compatible writer with explicit close behavior:

~~~
function writeResult(resultFile, payload) {
    var text = JSON.stringify(payload, null, 2);
    if (!resultFile.parent.exists && !resultFile.parent.create()) {
        throw new Error("Cannot create result directory");
    }
    if (!resultFile.open("w")) {
        throw new Error("Cannot open result file");
    }
    try {
        resultFile.encoding = "UTF-8";
        resultFile.write(text);
    } finally {
        resultFile.close();
    }
}
~~~

Use a serializer compatible with the target ExtendScript engine if JSON.stringify is unavailable. Have the launcher validate all of the following before accepting a pass:

- The file was created or modified after the current run started.
- The payload contains the current runId and intended scenario.
- The final stage, success value, AE version, and named checks satisfy the expectation.
- The host process did not leave the result at an intermediate stage.

## Probe Lifecycle

1. Create a task-owned output directory and record the start timestamp.
2. Write the starting payload.
3. Create only the minimal project state needed for the scenario.
4. Load the exact host bundle or target entry point under test.
5. Execute named assertions and append each result or error.
6. Write the final payload in a cleanup-safe path.
7. Preserve the result and relevant fresh log path when a probe fails.

Avoid alert dialogs, UI observation, user desktop paths, and implicit active-selection assumptions. Restore any project state only when doing so is safe and owned by the probe.

## Command Patterns

Use absolute paths and prefer a repository-proven launcher. On Windows, use the console executable supplied by the installed AE version when available:

~~~
& "E:\path\to\Adobe After Effects 2025\Support Files\AfterFX.com" -r "E:\repo\tools\checks\ae-probes\probe.jsx"
~~~

Use Adobe's documented direct command form as a fallback:

~~~
afterfx.exe -r C:\script_path\probe.jsx
~~~

Run a source syntax-style gate for a .jsx file only as a lower-level check:

~~~
node -e "const fs=require('node:fs'); new Function(fs.readFileSync('tools/checks/ae-probes/probe.jsx','utf8')); console.log('probe syntax ok')"
~~~

Do not call this a host-runtime pass. The actual AE run and fresh result file are the host evidence.

## CEP Debug Checklist

- Confirm the installed extension root contains the intended CSXS/manifest.xml, client, host, and development-only .debug file when required.
- Confirm .debug maps the manifest extension id and target host to the expected free port.
- Confirm the matching CSXS runtime has the required debug state before expecting unsigned development extensions to load.
- Capture CEPHtmlEngine and PlugPlug logs that are fresh relative to the test run.
- Compare the changed source file and installed file by content or SHA-256.
- Exercise bridge calls from the real CEP panel rather than a standalone browser page.

## AEX Probe Checklist

- Cover parameter count/order, match names, PiPL/resource identifiers, entry points, and added or removed controls with source-contract tests.
- Build the configured artifact and install it into the intended AE plugin directory using the repository's installer when available.
- Confirm Plugin Loading.log recognizes the artifact before investing in render diagnosis.
- Create a minimal comp, apply the effect, render or sample the output, and write a fresh JSON result.
- Verify MFR claims through flags/resources and a scenario that exercises the claimed concurrent-render behavior.
