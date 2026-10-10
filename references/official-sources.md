# Adobe Sources and Authority

Use the current shipped host/SDK version as the final authority for availability and binary/resource contracts. Use the sources below to establish expected behavior before relying on memory.

## Authority Order

1. The target host version, installed SDK headers, PiPL/resource definitions, and Adobe-supplied samples that build with the project.
2. Adobe-maintained CEP repositories and Adobe Developer documentation.
3. The Docs for Adobe rendering of the After Effects scripting and C++ SDK guides; verify version-sensitive details against the shipped SDK.
4. Repository knowledge for local paths, approved workarounds, and reproducible environment limitations.

## CEP

- Adobe CEP Resources: https://github.com/Adobe-CEP/CEP-Resources
- CEP 12 HTML Extension Cookbook: https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md
- CEP 11.1 HTML Extension Cookbook: https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_11.x/Documentation/CEP%2011.1%20HTML%20Extension%20Cookbook.md
- Adobe CEP Getting Started Guides: https://github.com/Adobe-CEP/Getting-Started-guides

Use these for manifest structure, DispatchInfo resources, MainPath/ScriptPath, .debug files, remote debugging ports, PlayerDebugMode, LogLevel, CEPHtmlEngine/PlugPlug logs, browser-runtime generations, and extension packaging.

## After Effects Scripting and JSX

- Adobe After Effects developer hub: https://developer.adobe.com/after-effects/
- Adobe Scripts in After Effects: https://helpx.adobe.com/after-effects/using/scripts.html
- After Effects Scripting Guide: https://ae-scripting.docsforadobe.dev/

Use these for script execution, .jsx/.jsxbin behavior, ScriptUI panels, file/network permissions, command-line scripting, and host API expectations.

## After Effects C++ SDK and AEX

- After Effects C++ SDK Guide: https://ae-plugins.docsforadobe.dev/
- Multi-Frame Rendering guide: https://ae-plugins.docsforadobe.dev/effect-details/multi-frame-rendering-in-ae/
- PF_OutData and PF_OutFlags2 reference: https://ae-plugins.docsforadobe.dev/effect-basics/PF_OutData/

Use these for entry points, PiPL/resource contracts, effect flags, MFR/thread-safety, sequence data, render selectors, and plugin loader expectations.

## Source-Conflict Policy

- Prefer the shipping SDK and a local reproduction when documentation and observed behavior conflict.
- Record the host version, CEP runtime, OS, and reproduction result with any version-specific conclusion.
- Do not promote an issue thread, an old blog post, or a browser-only mock to an API guarantee.
