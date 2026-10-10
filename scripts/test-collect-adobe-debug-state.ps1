[CmdletBinding()]
param(
    [string]$CollectorPath = "",
    [switch]$KeepFixture
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($CollectorPath)) {
    $CollectorPath = Join-Path $PSScriptRoot "collect-adobe-debug-state.ps1"
}

function Assert-Condition {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Write-Utf8File {
    param(
        [string]$PathValue,
        [string]$Content
    )
    $parent = Split-Path -Path $PathValue -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [IO.File]::WriteAllText($PathValue, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-Collector {
    param(
        [string]$SourceRoot,
        [string]$TargetRoot,
        [string]$ExtensionId,
        [string[]]$ComparePath = @(),
        [string]$ResultPath = "",
        [switch]$SkipLogDiscovery
    )
    $collectorArguments = @{
        RepoPath = $SourceRoot
        ExtensionRoot = $TargetRoot
        ExtensionId = $ExtensionId
    }
    if ($ComparePath.Count -gt 0) {
        $collectorArguments.CompareRelativePath = $ComparePath
    }
    if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
        $collectorArguments.OutputPath = $ResultPath
    }
    if ($SkipLogDiscovery) {
        $collectorArguments.SkipLogDiscovery = $true
    }
    $raw = & $CollectorPath @collectorArguments 2>&1
    return ($raw | Out-String | ConvertFrom-Json)
}

function ConvertTo-SingleQuotedPowerShellLiteral {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Invoke-CollectorThroughPowerShell {
    param(
        [string]$SourceRoot,
        [string]$TargetRoot,
        [string]$ExtensionId,
        [string[]]$ComparePath
    )
    $quotedPaths = @($ComparePath | ForEach-Object { ConvertTo-SingleQuotedPowerShellLiteral -Value $_ }) -join ","
    $command = (
        "& {0} -RepoPath {1} -ExtensionRoot {2} -ExtensionId {3} -CompareRelativePath @({4}) -SkipLogDiscovery" -f
        (ConvertTo-SingleQuotedPowerShellLiteral -Value $CollectorPath),
        (ConvertTo-SingleQuotedPowerShellLiteral -Value $SourceRoot),
        (ConvertTo-SingleQuotedPowerShellLiteral -Value $TargetRoot),
        (ConvertTo-SingleQuotedPowerShellLiteral -Value $ExtensionId),
        $quotedPaths
    )
    $raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $command 2>&1
    return ($raw | Out-String | ConvertFrom-Json)
}

if (-not (Test-Path -LiteralPath $CollectorPath -PathType Leaf)) {
    throw "Collector script not found: $CollectorPath"
}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("cep-jsx-aex-debug-state-test-" + [Guid]::NewGuid().ToString("N"))
$sourceRoot = Join-Path $fixtureRoot "source"
$targetRoot = Join-Path $fixtureRoot "installed"
$resultPath = Join-Path $fixtureRoot "collector-result.json"

$manifest = @'
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionManifest xmlns="http://www.adobe.com/CEP/11" ExtensionBundleId="com.example.collector" ExtensionBundleVersion="1.2.3" Version="11.0">
  <ExtensionList>
    <Extension Id="com.example.collector.panel" Version="1.2.3" />
    <Extension Id="com.example.collector.escape" Version="1.2.3" />
  </ExtensionList>
  <ExecutionEnvironment>
    <HostList>
      <Host Name="AEFT" Version="[24.0,99.9]" />
    </HostList>
    <LocaleList>
      <Locale Code="All" />
    </LocaleList>
    <RequiredRuntimeList>
      <RequiredRuntime Name="CSXS" Version="11.0" />
    </RequiredRuntimeList>
  </ExecutionEnvironment>
  <DispatchInfoList>
    <Extension Id="com.example.collector.panel">
      <DispatchInfo>
        <Resources>
          <MainPath>./client/index.html</MainPath>
          <ScriptPath>./host/bootstrap.jsx</ScriptPath>
        </Resources>
        <UI>
          <Type>Panel</Type>
        </UI>
      </DispatchInfo>
    </Extension>
    <Extension Id="com.example.collector.escape">
      <DispatchInfo>
        <Resources>
          <MainPath>../outside.html</MainPath>
        </Resources>
      </DispatchInfo>
    </Extension>
  </DispatchInfoList>
</ExtensionManifest>
'@

$debug = @'
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="com.example.collector.panel">
    <HostList>
      <Host Name="AEFT" Port="8099" />
    </HostList>
  </Extension>
  <Extension Id="com.example.collector.escape">
    <HostList>
      <Host Name="AEFT" Port="70000" />
    </HostList>
  </Extension>
</ExtensionList>
'@

try {
    foreach ($root in @($sourceRoot, $targetRoot)) {
        Write-Utf8File -PathValue (Join-Path $root "CSXS\manifest.xml") -Content $manifest
        Write-Utf8File -PathValue (Join-Path $root ".debug") -Content $debug
        Write-Utf8File -PathValue (Join-Path $root "client\index.html") -Content "<!doctype html><title>collector fixture</title>"
        Write-Utf8File -PathValue (Join-Path $root "host\bootstrap.jsx") -Content "var collectorFixture = true;"
    }

    $matchResult = Invoke-Collector -SourceRoot $sourceRoot -TargetRoot $targetRoot -ExtensionId "com.example.collector.panel" -ComparePath @("client\index.html", "host\bootstrap.jsx") -ResultPath $resultPath -SkipLogDiscovery
    $targetSnapshot = @($matchResult.inspectedRoots | Where-Object { $_.root -eq $targetRoot })[0]
    $panelContract = $targetSnapshot.extensionContract
    $panelMapping = @($panelContract.debugMappings)[0]
    $matchComparisons = @($matchResult.fileParity.comparisons)
    Assert-Condition -Condition ($matchResult.schemaVersion -eq 3) -Message "Expected collector schema version 3."
    Assert-Condition -Condition ($matchResult.logDiscoverySkipped -and @($matchResult.recentCepLogs).Count -eq 0 -and @($matchResult.recentPluginLoadingLogs).Count -eq 0) -Message "Expected fixture test to skip log discovery."
    Assert-Condition -Condition (Test-Path -LiteralPath $resultPath -PathType Leaf) -Message "Expected collector JSON output file."
    Assert-Condition -Condition $targetSnapshot.manifestContract.hasCompleteDispatchCoverage -Message "Expected complete DispatchInfo coverage."
    Assert-Condition -Condition ($panelContract.mainPathState.insideExtensionRoot -and $panelContract.mainPathState.exists) -Message "Expected an existing in-root MainPath."
    Assert-Condition -Condition ($panelContract.scriptPathState.insideExtensionRoot -and $panelContract.scriptPathState.exists) -Message "Expected an existing in-root ScriptPath."
    Assert-Condition -Condition ($panelMapping.portIsValid -and $panelMapping.portNumber -eq 8099) -Message "Expected a valid debug port mapping."
    Assert-Condition -Condition ($matchComparisons.Count -eq 2 -and @($matchComparisons | Where-Object { $_.status -ne "match" }).Count -eq 0) -Message "Expected matching source and installed file fingerprints."

    $processBoundaryResult = Invoke-CollectorThroughPowerShell -SourceRoot $sourceRoot -TargetRoot $targetRoot -ExtensionId "com.example.collector.panel" -ComparePath @("client\index.html", "host\bootstrap.jsx")
    $processBoundaryComparisons = @($processBoundaryResult.fileParity.comparisons)
    Assert-Condition -Condition ($processBoundaryComparisons.Count -eq 2 -and @($processBoundaryComparisons | Where-Object { $_.status -ne "match" }).Count -eq 0) -Message "Expected the PowerShell command boundary to preserve every comparison path."

    Write-Utf8File -PathValue (Join-Path $targetRoot "host\bootstrap.jsx") -Content "var collectorFixture = false;"
    $mismatchResult = Invoke-Collector -SourceRoot $sourceRoot -TargetRoot $targetRoot -ExtensionId "com.example.collector.panel" -ComparePath @("host\bootstrap.jsx") -SkipLogDiscovery
    $mismatchComparison = @($mismatchResult.fileParity.comparisons)[0]
    Assert-Condition -Condition ($mismatchComparison.status -eq "mismatch" -and $mismatchComparison.sha256Match -eq $false) -Message "Expected a source/install fingerprint mismatch."

    $escapingPathResult = Invoke-Collector -SourceRoot $sourceRoot -TargetRoot $targetRoot -ExtensionId "com.example.collector.panel" -ComparePath @("..\outside.html") -SkipLogDiscovery
    $escapingPathComparison = @($escapingPathResult.fileParity.comparisons)[0]
    Assert-Condition -Condition ($escapingPathComparison.status -eq "invalidSourcePath") -Message "Expected an escaping comparison path to be rejected."

    $escapeResult = Invoke-Collector -SourceRoot $sourceRoot -TargetRoot $targetRoot -ExtensionId "com.example.collector.escape" -SkipLogDiscovery
    $escapeSnapshot = @($escapeResult.inspectedRoots | Where-Object { $_.root -eq $targetRoot })[0]
    Assert-Condition -Condition ($escapeSnapshot.extensionContract.resourceIssues -contains "mainPathOutsideExtensionRoot") -Message "Expected an out-of-root MainPath violation."
    Assert-Condition -Condition ($escapeSnapshot.debug.issues -contains "debugMappingInvalidPort:com.example.collector.escape:AEFT:70000") -Message "Expected an invalid debug port diagnostic."

    foreach ($root in @($sourceRoot, $targetRoot)) {
        Write-Utf8File -PathValue (Join-Path $root "CSXS\manifest.xml") -Content "<ExtensionManifest"
    }
    $invalidManifestResult = Invoke-Collector -SourceRoot $sourceRoot -TargetRoot $targetRoot -ExtensionId "com.example.collector.panel" -SkipLogDiscovery
    $invalidManifestSnapshot = @($invalidManifestResult.inspectedRoots | Where-Object { $_.root -eq $targetRoot })[0]
    Assert-Condition -Condition (-not $invalidManifestSnapshot.manifestContract.hasCompleteDispatchCoverage -and -not [string]::IsNullOrWhiteSpace($invalidManifestSnapshot.manifestContract.error)) -Message "Expected a manifest parse failure to invalidate dispatch coverage."

    [ordered]@{
        success = $true
        schemaVersion = $matchResult.schemaVersion
        scenarios = @(
            "defaultNamespaceAndDispatchInfo",
            "validManifestResources",
            "validDebugPort",
            "sourceInstalledMatch",
            "processBoundaryArrayArguments",
            "sourceInstalledMismatch",
            "escapingComparePath",
            "outOfRootManifestResource",
            "invalidDebugPort",
            "invalidManifestDoesNotPassContract"
        )
    } | ConvertTo-Json -Compress
} finally {
    if (-not $KeepFixture -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
