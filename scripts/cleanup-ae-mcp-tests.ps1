[CmdletBinding()]
param([switch]$Delete, [string]$SessionId)
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) 'AEffectMCP-managed-tests'
if ($SessionId -and $SessionId -cnotmatch '^session-[A-Za-z0-9]+$') { throw 'Invalid sessionId' }
$items = @()
if (Test-Path -LiteralPath $root) {
  $rootItem = Get-Item -LiteralPath $root -Force
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Managed root is not a real directory.' }
  foreach ($session in @(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.PSIsContainer -and $_.Name -match '^session-[A-Za-z0-9]+$' -and (-not $SessionId -or $_.Name -ceq $SessionId) })) {
    $reason = $null
    try {
      if ($session.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Session is a reparse point' }
      $marker = Join-Path $session.FullName '.ae-mcp-session.json'
      $markerItem = Get-Item -LiteralPath $marker -Force
      if ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Marker is a reparse point' }
      $info = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($info.schemaVersion -ne 1 -or $info.sessionId -cne $session.Name) { throw 'Invalid session marker' }
      $collab = Join-Path $session.FullName '.ae-mcp-collab.json'
      $collabLock = Join-Path $session.FullName '.ae-mcp-collab-lock'
      if (Test-Path -LiteralPath $collabLock) { throw 'Collaboration operation is locked or unknown' }
      if (Test-Path -LiteralPath $collab) {
        $collabInfo = Get-Content -LiteralPath $collab -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($collabInfo.schemaVersion -ne 1 -or $collabInfo.sessionId -cne $session.Name -or $collabInfo.state -cne 'closed') { throw 'Collaboration session is active or invalid' }
      }
      $contents = @(Get-ChildItem -LiteralPath $session.FullName -Force -Recurse)
      if (@($contents | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -gt 0) { throw 'Contains a reparse point' }
      foreach ($run in @($contents | Where-Object { $_.PSIsContainer -and $_.Name -match '^ae-mcp-' })) {
        $request = Join-Path $run.FullName 'request.json'
        $result = Join-Path $run.FullName 'host-result.json'
        $render = Join-Path $run.FullName 'render-job.json'
        $diagnostic = Join-Path $run.FullName 'collector-process.json'
        if (Test-Path -LiteralPath $request) {
          if (-not (Test-Path -LiteralPath $result)) { throw 'JSX result missing; execution may still be active' }
          $req = Get-Content -LiteralPath $request -Raw -Encoding UTF8 | ConvertFrom-Json
          $res = Get-Content -LiteralPath $result -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($req.runId -cne $res.runId -or $res.stage -notin @('complete','failed')) { throw 'JSX execution is pending or unknown' }
        } elseif (Test-Path -LiteralPath $render) {
          $job = Get-Content -LiteralPath $render -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($job.state -notin @('complete','failed')) { throw 'Render is pending or unknown' }
        } elseif (-not (Test-Path -LiteralPath $diagnostic)) { throw 'Run is pending or unknown' }
      }
    } catch { $reason = $_.Exception.Message }
    $action = if ($reason) { 'skipped' } elseif ($Delete) { 'deleted' } else { 'eligible' }
    if ($action -eq 'deleted') {
      try { Remove-Item -LiteralPath $session.FullName -Recurse -Force -ErrorAction Stop }
      catch { $action = 'skipped'; $reason = $_.Exception.Message }
    }
    $items += [PSCustomObject]@{ sessionId=$session.Name; sessionDir=$session.FullName; action=$action; reason=$reason }
  }
}
[PSCustomObject]@{ root=$root; mode=$(if ($Delete) {'delete'} else {'preview'}); sessions=@($items) } | ConvertTo-Json -Depth 8 -Compress
