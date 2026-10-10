# AEX Lifecycle and Native Host Contracts

## Parameter and Resource Parity

Treat the following as one public contract:

- Parameter order, count, defaults, ranges, match names, and UI flags.
- PiPL/resource identifiers and declared flags.
- Entry-point selectors and build-export configuration.
- JSX/CEP callers and any persisted parameter migration.

Add a focused source-contract test when changing any member of that contract. A build can succeed while a stale PiPL value, wrong match name, or mismatched caller leaves the effect unusable in AE.

## Checkout and Cleanup Symmetry

Audit render-adjacent callbacks for resource ownership:

1. Record every successful PF_CHECKOUT_PARAM or suite/resource acquisition.
2. Ensure every success, error, and early-return path performs the matching PF_CHECKIN_PARAM or release.
3. Preserve the plug-in's existing error-aggregation and cleanup style.
4. Add a narrow source assertion for symmetry when the lifecycle is easy to regress.

Do not infer lifecycle safety from a single visual render. Leaks and invalid ownership often appear only after repeated previews, errors, or MFR activity.

## Multi-Frame Rendering

Claim MFR support only after verifying all applicable parts:

- Set the intended source flags during the correct global setup path.
- Keep the matching PiPL/resource declaration in sync.
- Audit sequence data, global state, caches, suites, and render state for concurrent access.
- Use per-thread or immutable state where required; follow the SDK contract for flattened or mutable sequence data.
- Run a real render scenario appropriate to the host/version and retain the result.

PF_OutFlag2_SUPPORTS_THREADED_RENDERING indicates a concurrency claim, not merely a performance preference. Do not set it based on build success alone.

## Build, Installation, and Loader

1. Build the repository's intended configuration and architecture.
2. Use its installer/copy script to place the artifact in the exact target AE plugin directory.
3. Inspect the fresh Plugin Loading.log and record the recognized artifact/version.
4. Confirm the loaded artifact matches the build output by path, timestamp, version, or hash.
5. Apply the effect to a minimal comp and assert the requested render/sample behavior.

Treat "plugin listed by the loader" and "plugin rendered correctly" as separate gates.

## Crash and Timeout Triage

Start from host evidence:

- Request or inspect an AfterFX crash dump, Windows event fault details, or a minimal reproducible host crash.
- Compare a control binary/probe when practical.
- Record whether the failure occurred in delivery, loading, parameter setup, pre-render, render, cleanup, or output writeback.

Do not attribute an AE command-line timeout to the plugin until the same harness successfully executes a control or produces a host-side result. Restore only task-owned temporary binaries and helpers after a failed probe; never broadly terminate user-owned AE or process trees.
