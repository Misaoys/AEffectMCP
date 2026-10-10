[CmdletBinding()]
param(
    [string]$RepoPath = (Get-Location).Path,
    [string]$ExtensionRoot = "",
    [string]$AfterEffectsRoot = "",
    [string]$ExtensionId = "",
    [int[]]$CepMajor = @(9, 10, 11, 12),
    [string[]]$SearchRoot = @(),
    [string[]]$CompareRelativePath = @(),
    [switch]$SkipLogDiscovery,
    [datetime]$Since = [datetime]::MinValue,
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$hasSince = $PSBoundParameters.ContainsKey("Since")

function Resolve-ExistingPath {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $null
    }
    try {
        return (Resolve-Path -LiteralPath $PathValue -ErrorAction Stop).Path
    } catch {
        return $null
    }
}

function Get-FileFingerprint {
    param([string]$PathValue)
    $fingerprint = [ordered]@{
        path = $PathValue
        exists = $false
        length = $null
        lastWriteTime = $null
        sha256 = $null
        error = $null
    }
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
        return $fingerprint
    }
    try {
        $item = Get-Item -LiteralPath $PathValue -ErrorAction Stop
        $fingerprint.exists = $true
        $fingerprint.length = $item.Length
        $fingerprint.lastWriteTime = $item.LastWriteTime.ToString("o")
        $fingerprint.sha256 = (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256 -ErrorAction Stop).Hash
    } catch {
        $fingerprint.error = $_.Exception.Message
    }
    return $fingerprint
}

function Get-ExtensionResourceState {
    param(
        [string]$Root,
        [string]$ConfiguredPath
    )
    $state = [ordered]@{
        configuredPath = $ConfiguredPath
        kind = $null
        resolvedPath = $null
        insideExtensionRoot = $null
        exists = $null
        fingerprint = $null
        error = $null
    }
    if ([string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        $state.kind = "notConfigured"
        return $state
    }
    $value = $ConfiguredPath.Trim()
    if ([Uri]::IsWellFormedUriString($value, [UriKind]::Absolute)) {
        $state.kind = "absoluteUri"
        return $state
    }
    if ([IO.Path]::IsPathRooted($value)) {
        $state.kind = "absolutePath"
        $state.insideExtensionRoot = $false
        $state.error = "Resource path is absolute; expected a relative extension path."
        return $state
    }
    try {
        $state.kind = "relativePath"
        $rootFullPath = [IO.Path]::GetFullPath($Root)
        $rootPrefix = $rootFullPath.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
        $candidatePath = [IO.Path]::GetFullPath((Join-Path $rootFullPath $value))
        $state.resolvedPath = $candidatePath
        $state.insideExtensionRoot = $candidatePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
        if (-not $state.insideExtensionRoot) {
            $state.error = "Resource path resolves outside the extension root."
            return $state
        }
        $state.fingerprint = Get-FileFingerprint -PathValue $candidatePath
        $state.exists = [bool]$state.fingerprint.exists
    } catch {
        $state.error = $_.Exception.Message
    }
    return $state
}

function Get-RelativeFileState {
    param(
        [string]$Root,
        [string]$RelativePath
    )
    $resource = Get-ExtensionResourceState -Root $Root -ConfiguredPath $RelativePath
    return [ordered]@{
        root = $Root
        relativePath = $RelativePath
        resolvedPath = $resource.resolvedPath
        validRelativePath = ($resource.kind -eq "relativePath" -and $resource.insideExtensionRoot)
        exists = $resource.exists
        fingerprint = $resource.fingerprint
        error = $resource.error
    }
}

function Compare-RelativeFiles {
    param(
        [string]$SourceRoot,
        [string]$TargetRoot,
        [string[]]$RelativePaths
    )
    $comparisons = @()
    foreach ($relativePath in @($RelativePaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
        $source = Get-RelativeFileState -Root $SourceRoot -RelativePath $relativePath
        $target = Get-RelativeFileState -Root $TargetRoot -RelativePath $relativePath
        $status = "unavailable"
        $sha256Match = $null
        if (-not $source.validRelativePath) {
            $status = "invalidSourcePath"
        } elseif (-not $target.validRelativePath) {
            $status = "invalidTargetPath"
        } elseif (-not $source.exists) {
            $status = "missingSource"
        } elseif (-not $target.exists) {
            $status = "missingTarget"
        } else {
            $sha256Match = $source.fingerprint.sha256 -eq $target.fingerprint.sha256
            $status = if ($sha256Match) { "match" } else { "mismatch" }
        }
        $comparisons += [ordered]@{
            relativePath = $relativePath
            status = $status
            sha256Match = $sha256Match
            source = $source
            target = $target
        }
    }
    return $comparisons
}

function Get-XmlNodeText {
    param(
        [System.Xml.XmlNode]$Node,
        [string]$XPath
    )
    if ($null -eq $Node) {
        return $null
    }
    $child = $Node.SelectSingleNode($XPath)
    if ($null -eq $child) {
        return $null
    }
    return ([string]$child.InnerText).Trim()
}

function Get-ManifestContract {
    param($Manifest)
    if ($null -eq $Manifest) {
        return $null
    }
    if (-not [string]::IsNullOrWhiteSpace($Manifest.error)) {
        return [ordered]@{
            extensionListIds = @()
            dispatchInfoIds = @()
            missingDispatchInfoIds = @()
            orphanDispatchInfoIds = @()
            duplicateDispatchInfoIds = @()
            hasCompleteDispatchCoverage = $false
            error = $Manifest.error
        }
    }
    $extensionIds = @($Manifest.extensions | ForEach-Object { $_.id } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    $dispatchInfoIds = @($Manifest.dispatchInfos | ForEach-Object { $_.id } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    $duplicateDispatchInfoIds = @($Manifest.dispatchInfos |
        Group-Object id |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_.Name) -and $_.Count -gt 1 } |
        ForEach-Object { $_.Name })
    return [ordered]@{
        extensionListIds = $extensionIds
        dispatchInfoIds = $dispatchInfoIds
        missingDispatchInfoIds = @($extensionIds | Where-Object { $_ -notin $dispatchInfoIds })
        orphanDispatchInfoIds = @($dispatchInfoIds | Where-Object { $_ -notin $extensionIds })
        duplicateDispatchInfoIds = $duplicateDispatchInfoIds
        hasCompleteDispatchCoverage = (
            $extensionIds.Count -gt 0 -and
            @($extensionIds | Where-Object { $_ -notin $dispatchInfoIds }).Count -eq 0 -and
            @($dispatchInfoIds | Where-Object { $_ -notin $extensionIds }).Count -eq 0 -and
            $duplicateDispatchInfoIds.Count -eq 0
        )
        error = $null
    }
}

function Read-TextFileHead {
    param(
        [string]$PathValue,
        [int]$LineCount = 80
    )
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $PathValue -Encoding UTF8 -TotalCount $LineCount -ErrorAction Stop) -join [Environment]::NewLine
    } catch {
        return "[read failed] $($_.Exception.Message)"
    }
}

function Get-ManifestSummary {
    param([string]$Root)
    $manifestPath = Join-Path $Root "CSXS\manifest.xml"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        return $null
    }
    $summary = [ordered]@{
        path = $manifestPath
        file = Get-FileFingerprint -PathValue $manifestPath
        extensionBundleId = $null
        extensionBundleVersion = $null
        manifestVersion = $null
        cepRuntime = $null
        requiredRuntimes = @()
        extensions = @()
        hosts = @()
        dispatchInfos = @()
        error = $null
    }
    try {
        [xml]$manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw -ErrorAction Stop
        $rootNode = $manifest.DocumentElement
        $summary.extensionBundleId = [string]$rootNode.GetAttribute("ExtensionBundleId")
        $summary.extensionBundleVersion = [string]$rootNode.GetAttribute("ExtensionBundleVersion")
        $summary.manifestVersion = [string]$rootNode.GetAttribute("Version")
        $summary.requiredRuntimes = @($manifest.SelectNodes("//*[local-name()='RequiredRuntimeList']/*[local-name()='RequiredRuntime']") | ForEach-Object {
            [ordered]@{ name = [string]$_.GetAttribute("Name"); version = [string]$_.GetAttribute("Version") }
        })
        if ($summary.requiredRuntimes.Count -gt 0) {
            $summary.cepRuntime = [string]$summary.requiredRuntimes[0].version
        }
        $summary.extensions = @($manifest.SelectNodes("//*[local-name()='ExtensionList']/*[local-name()='Extension']") | ForEach-Object {
            [ordered]@{ id = [string]$_.GetAttribute("Id"); version = [string]$_.GetAttribute("Version") }
        })
        $summary.hosts = @($manifest.SelectNodes("//*[local-name()='HostList']/*[local-name()='Host']") | ForEach-Object {
            [ordered]@{ name = [string]$_.GetAttribute("Name"); version = [string]$_.GetAttribute("Version") }
        })
        $summary.dispatchInfos = @(
            foreach ($extensionNode in @($manifest.SelectNodes("//*[local-name()='DispatchInfoList']/*[local-name()='Extension']"))) {
                $extensionId = [string]$extensionNode.GetAttribute("Id")
                $dispatchNodes = @($extensionNode.SelectNodes("./*[local-name()='DispatchInfo']"))
                if ($dispatchNodes.Count -eq 0) {
                    [ordered]@{
                        id = $extensionId
                        dispatchInfoPresent = $false
                        mainPath = $null
                        mainPathState = Get-ExtensionResourceState -Root $Root -ConfiguredPath $null
                        scriptPath = $null
                        scriptPathState = Get-ExtensionResourceState -Root $Root -ConfiguredPath $null
                        uiType = $null
                    }
                    continue
                }
                foreach ($dispatchNode in $dispatchNodes) {
                    $resourcesNode = $dispatchNode.SelectSingleNode("./*[local-name()='Resources']")
                    $mainPath = Get-XmlNodeText -Node $resourcesNode -XPath "./*[local-name()='MainPath']"
                    $scriptPath = Get-XmlNodeText -Node $resourcesNode -XPath "./*[local-name()='ScriptPath']"
                    [ordered]@{
                        id = $extensionId
                        dispatchInfoPresent = $true
                        mainPath = $mainPath
                        mainPathState = Get-ExtensionResourceState -Root $Root -ConfiguredPath $mainPath
                        scriptPath = $scriptPath
                        scriptPathState = Get-ExtensionResourceState -Root $Root -ConfiguredPath $scriptPath
                        uiType = Get-XmlNodeText -Node $dispatchNode -XPath "./*[local-name()='UI']/*[local-name()='Type']"
                    }
                }
            }
        )
    } catch {
        $summary.error = $_.Exception.Message
    }
    return $summary
}

function Get-DebugFileSummary {
    param([string]$Root)
    $debugPath = Join-Path $Root ".debug"
    if (-not (Test-Path -LiteralPath $debugPath -PathType Leaf)) {
        return $null
    }
    $summary = [ordered]@{
        path = $debugPath
        file = Get-FileFingerprint -PathValue $debugPath
        entries = @()
        issues = @()
        rawHead = $null
        error = $null
    }
    try {
        [xml]$debugXml = Get-Content -LiteralPath $debugPath -Encoding UTF8 -Raw -ErrorAction Stop
        $entries = @()
        $issues = @()
        foreach ($extensionNode in @($debugXml.SelectNodes("//*[local-name()='Extension']"))) {
            $extensionId = [string]$extensionNode.GetAttribute("Id")
            foreach ($hostNode in @($extensionNode.SelectNodes(".//*[local-name()='Host']"))) {
                $hostName = [string]$hostNode.GetAttribute("Name")
                $portText = [string]$hostNode.GetAttribute("Port")
                $portNumber = 0
                $isPortNumeric = [int]::TryParse($portText, [ref]$portNumber)
                $isPortValid = $isPortNumeric -and $portNumber -ge 1024 -and $portNumber -lt 65535
                $entries += [ordered]@{
                    id = $extensionId
                    host = $hostName
                    port = $portText
                    portNumber = if ($isPortNumeric) { $portNumber } else { $null }
                    portIsValid = $isPortValid
                    duplicate = $false
                }
                if ([string]::IsNullOrWhiteSpace($extensionId)) {
                    $issues += "debugMappingMissingExtensionId"
                }
                if ([string]::IsNullOrWhiteSpace($hostName)) {
                    $issues += "debugMappingMissingHost"
                }
                if (-not $isPortValid) {
                    $issues += ("debugMappingInvalidPort:" + $extensionId + ":" + $hostName + ":" + $portText)
                }
            }
        }
        $seenMappings = @{}
        foreach ($entry in $entries) {
            $key = "$($entry.id)|$($entry.host)|$($entry.port)"
            if ($seenMappings.ContainsKey($key)) {
                $entry.duplicate = $true
                $issues += "duplicateDebugMapping:$key"
            } else {
                $seenMappings[$key] = $true
            }
        }
        $summary.entries = $entries
        $summary.issues = @($issues | Select-Object -Unique)
    } catch {
        $summary.error = $_.Exception.Message
        $summary.rawHead = Read-TextFileHead -PathValue $debugPath -LineCount 40
    }
    return $summary
}

function Get-CSXSRegistry {
    param([int[]]$Versions)
    $items = @()
    foreach ($major in $Versions) {
        $path = "HKCU:\Software\Adobe\CSXS.$major"
        $entry = [ordered]@{
            key = $path
            exists = Test-Path -LiteralPath $path
            PlayerDebugMode = $null
            LogLevel = $null
            error = $null
        }
        if ($entry.exists) {
            try {
                $props = Get-ItemProperty -LiteralPath $path -ErrorAction Stop
                $entry.PlayerDebugMode = [string]$props.PlayerDebugMode
                $entry.LogLevel = [string]$props.LogLevel
            } catch {
                $entry.error = $_.Exception.Message
            }
        }
        $items += $entry
    }
    return $items
}

function Get-RecentFiles {
    param(
        [string[]]$Roots,
        [string[]]$Patterns,
        [int]$Limit = 20,
        [datetime]$SinceValue = [datetime]::MinValue
    )
    $files = @()
    foreach ($root in @($Roots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            continue
        }
        foreach ($pattern in $Patterns) {
            try {
                $files += Get-ChildItem -LiteralPath $root -Filter $pattern -File -Recurse -Depth 4 -ErrorAction SilentlyContinue
            } catch {
            }
        }
    }
    return @($files |
        Sort-Object FullName -Unique |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First $Limit |
        ForEach-Object {
            [ordered]@{
                path = $_.FullName
                lastWriteTime = $_.LastWriteTime.ToString("o")
                length = $_.Length
                isFresh = if ($SinceValue -eq [datetime]::MinValue) { $null } else { $_.LastWriteTime -ge $SinceValue }
            }
        })
}

function Find-AfterFx {
    param(
        [string]$Root,
        [string[]]$AdditionalRoots
    )
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($Root)) {
        $candidates += Join-Path $Root "Support Files\AfterFX.com"
        $candidates += Join-Path $Root "Support Files\AfterFX.exe"
    }
    $commonRoots = @(
        "C:\Program Files\Adobe",
        "C:\Program Files (x86)\Adobe"
    ) + @($AdditionalRoots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($commonRoot in @($commonRoots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $commonRoot -PathType Container)) {
            continue
        }
        try {
            $candidates += Get-ChildItem -LiteralPath $commonRoot -Directory -Filter "Adobe After Effects*" -ErrorAction SilentlyContinue |
                ForEach-Object {
                    @(
                        (Join-Path $_.FullName "Support Files\AfterFX.com"),
                        (Join-Path $_.FullName "Support Files\AfterFX.exe")
                    )
                }
        } catch {
        }
    }
    return @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
}

function Get-ExtensionContract {
    param(
        [string]$Root,
        $Manifest,
        $Debug,
        [string]$RequestedExtensionId
    )
    if ([string]::IsNullOrWhiteSpace($RequestedExtensionId)) {
        return $null
    }
    $manifestMatches = @()
    if ($null -ne $Manifest) {
        $manifestMatches = @($Manifest.extensions | Where-Object { $_.id -eq $RequestedExtensionId })
    }
    $debugMatches = @()
    if ($null -ne $Debug) {
        $debugMatches = @($Debug.entries | Where-Object { $_.id -eq $RequestedExtensionId })
    }
    $dispatchMatches = @()
    if ($null -ne $Manifest) {
        $dispatchMatches = @($Manifest.dispatchInfos | Where-Object { $_.id -eq $RequestedExtensionId })
    }
    $resourceIssues = @()
    $primaryDispatch = if ($dispatchMatches.Count -gt 0) { $dispatchMatches[0] } else { $null }
    if ($null -eq $primaryDispatch) {
        $resourceIssues += "missingDispatchInfo"
    } else {
        $mainPathState = $primaryDispatch.mainPathState
        if ($mainPathState.kind -eq "notConfigured") {
            $resourceIssues += "mainPathNotConfigured"
        } elseif ($mainPathState.kind -eq "relativePath" -and -not $mainPathState.insideExtensionRoot) {
            $resourceIssues += "mainPathOutsideExtensionRoot"
        } elseif ($mainPathState.kind -eq "relativePath" -and -not $mainPathState.exists) {
            $resourceIssues += "mainPathMissing"
        } elseif ($mainPathState.kind -eq "absolutePath") {
            $resourceIssues += "mainPathAbsolute"
        }
        $scriptPathState = $primaryDispatch.scriptPathState
        if ($scriptPathState.kind -eq "relativePath" -and -not $scriptPathState.insideExtensionRoot) {
            $resourceIssues += "scriptPathOutsideExtensionRoot"
        } elseif ($scriptPathState.kind -eq "relativePath" -and -not $scriptPathState.exists) {
            $resourceIssues += "scriptPathMissing"
        } elseif ($scriptPathState.kind -eq "absolutePath") {
            $resourceIssues += "scriptPathAbsolute"
        }
    }
    return [ordered]@{
        root = $Root
        extensionId = $RequestedExtensionId
        manifestContainsExtension = $manifestMatches.Count -gt 0
        debugFilePresent = $null -ne $Debug
        debugContainsExtension = if ($null -eq $Debug) { $null } else { $debugMatches.Count -gt 0 }
        debugMappings = $debugMatches
        dispatchInfoPresent = $dispatchMatches.Count -gt 0
        dispatchInfoCount = $dispatchMatches.Count
        mainPath = if ($null -eq $primaryDispatch) { $null } else { $primaryDispatch.mainPath }
        mainPathState = if ($null -eq $primaryDispatch) { $null } else { $primaryDispatch.mainPathState }
        scriptPath = if ($null -eq $primaryDispatch) { $null } else { $primaryDispatch.scriptPath }
        scriptPathState = if ($null -eq $primaryDispatch) { $null } else { $primaryDispatch.scriptPathState }
        resourceIssues = $resourceIssues
    }
}

$repoResolved = Resolve-ExistingPath -PathValue $RepoPath
$extensionResolved = Resolve-ExistingPath -PathValue $ExtensionRoot
$aeRootResolved = Resolve-ExistingPath -PathValue $AfterEffectsRoot
$rootsToInspect = @(@($repoResolved, $extensionResolved) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
$inspectedRoots = @($rootsToInspect | ForEach-Object {
    $manifest = Get-ManifestSummary -Root $_
    $debug = Get-DebugFileSummary -Root $_
    [ordered]@{
        root = $_
        manifest = $manifest
        manifestContract = Get-ManifestContract -Manifest $manifest
        debug = $debug
        extensionContract = Get-ExtensionContract -Root $_ -Manifest $manifest -Debug $debug -RequestedExtensionId $ExtensionId
    }
})

$appData = [Environment]::GetFolderPath("ApplicationData")
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$temp = [IO.Path]::GetTempPath()
$recentCepLogs = @()
$recentPluginLoadingLogs = @()
if (-not $SkipLogDiscovery) {
    $recentCepLogs = Get-RecentFiles -Roots @(
        $temp,
        (Join-Path $appData "Adobe\CEP\logs"),
        (Join-Path $localAppData "Temp")
    ) -Patterns @("CEP*.log", "CEPHtmlEngine*.log", "PlugPlug*.log", "cef_debug.log") -SinceValue $Since
    $recentPluginLoadingLogs = Get-RecentFiles -Roots @(
        (Join-Path $appData "Adobe\After Effects"),
        (Join-Path $localAppData "Adobe\After Effects")
    ) -Patterns @("Plugin Loading.log") -Limit 10 -SinceValue $Since
}
$fileParity = [ordered]@{
    sourceRoot = $repoResolved
    targetRoot = $extensionResolved
    requestedPaths = @($CompareRelativePath)
    comparisons = @()
    unavailableReason = $null
}
if ($fileParity.requestedPaths.Count -eq 0) {
    $fileParity.unavailableReason = "No relative paths requested."
} elseif ([string]::IsNullOrWhiteSpace($repoResolved)) {
    $fileParity.unavailableReason = "RepoPath does not resolve to an existing directory."
} elseif ([string]::IsNullOrWhiteSpace($extensionResolved)) {
    $fileParity.unavailableReason = "ExtensionRoot does not resolve to an existing directory."
} else {
    $fileParity.comparisons = Compare-RelativeFiles -SourceRoot $repoResolved -TargetRoot $extensionResolved -RelativePaths $CompareRelativePath
}

$result = [ordered]@{
    schemaVersion = 3
    collectedAt = (Get-Date).ToString("o")
    since = if ($hasSince) { $Since.ToString("o") } else { $null }
    repoPathInput = $RepoPath
    repoPath = $repoResolved
    extensionRootInput = $ExtensionRoot
    extensionRoot = $extensionResolved
    afterEffectsRootInput = $AfterEffectsRoot
    afterEffectsRoot = $aeRootResolved
    extensionId = $ExtensionId
    csxsRegistry = Get-CSXSRegistry -Versions $CepMajor
    afterFxCandidates = Find-AfterFx -Root $aeRootResolved -AdditionalRoots $SearchRoot
    inspectedRoots = $inspectedRoots
    fileParity = $fileParity
    logDiscoverySkipped = [bool]$SkipLogDiscovery
    recentCepLogs = $recentCepLogs
    recentPluginLoadingLogs = $recentPluginLoadingLogs
    outputPath = $null
}

if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $outputFullPath = [IO.Path]::GetFullPath($OutputPath)
    $outputDirectory = Split-Path -Path $outputFullPath -Parent
    if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    }
    $result.outputPath = $outputFullPath
}

$json = $result | ConvertTo-Json -Depth 12
if ($result.outputPath) {
    $temporaryOutput = "$($result.outputPath).$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporaryOutput, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryOutput -Destination $result.outputPath -Force
}

$json
