#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$ConfigRoot,
  [string]$CodexExe,
  [string]$CodexHome,
  [switch]$NoDefaultConfig,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-ChildPath([string]$Parent, [string]$Child) {
  $parentPath = (Get-FullPath $Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $childPath = Get-FullPath $Child
  $prefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $childPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside the install root: $childPath"
  }
}

function Assert-BundleIntegrity([string]$Root) {
  $manifestPath = Join-Path $Root 'MANIFEST.sha256'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Bundle integrity manifest is missing: $manifestPath"
  }
  foreach ($line in [System.IO.File]::ReadAllLines($manifestPath)) {
    if (-not $line.Trim()) { continue }
    if ($line -notmatch '^([a-f0-9]{64})  (.+)$') {
      throw "Malformed integrity manifest line: $line"
    }
    $relativePath = $Matches[2].Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $filePath = Get-FullPath (Join-Path $Root $relativePath)
    Assert-ChildPath $Root $filePath
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      throw "Bundle file is missing: $relativePath"
    }
    $actual = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Matches[1]) {
      throw "Bundle integrity check failed: $relativePath"
    }
  }
}

function Resolve-CodexExecutable([string]$Requested) {
  if ($Requested) {
    $resolved = Get-FullPath $Requested
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      throw "Codex executable not found: $resolved"
    }
    return $resolved
  }
  foreach ($name in @('codex.exe', 'codex')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
  }
  if ($env:LOCALAPPDATA) {
    $desktopRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $desktopRoot -PathType Container) {
      $candidate = Get-ChildItem -LiteralPath $desktopRoot -Filter codex.exe -File -Recurse |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      if ($candidate) { return $candidate.FullName }
    }
  }
  throw 'Codex CLI was not found. Install Codex or pass -CodexExe <path-to-codex.exe>.'
}

$bundleRoot = Get-FullPath $PSScriptRoot
Assert-BundleIntegrity $bundleRoot
$release = Get-Content -LiteralPath (Join-Path $bundleRoot 'release.json') -Raw | ConvertFrom-Json

if (-not $env:LOCALAPPDATA -and (-not $InstallRoot -or -not $ConfigRoot)) {
  throw 'LOCALAPPDATA is required unless -InstallRoot and -ConfigRoot are both supplied.'
}
if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA 'CrossSessionMemory\CodexPlugin'
}
if (-not $ConfigRoot) {
  $ConfigRoot = Join-Path $env:LOCALAPPDATA 'CrossSessionMemory\config'
}
$InstallRoot = Get-FullPath $InstallRoot
$ConfigRoot = Get-FullPath $ConfigRoot
$targetRoot = Get-FullPath (Join-Path $InstallRoot ([string]$release.version))
Assert-ChildPath $InstallRoot $targetRoot

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) { throw 'Node.js is required. Install the Node major listed in release.json.' }
$nodePlatform = (& $nodeCommand.Source -p process.platform).Trim()
$nodeArch = (& $nodeCommand.Source -p process.arch).Trim()
$nodeMajor = [int]((& $nodeCommand.Source -p "process.versions.node.split('.')[0]").Trim())
$nodeAbi = (& $nodeCommand.Source -p process.versions.modules).Trim()
if ($nodePlatform -ne [string]$release.platform -or $nodeArch -ne [string]$release.arch) {
  throw "This package requires $($release.platform)-$($release.arch); found $nodePlatform-$nodeArch."
}
if ($nodeMajor -ne [int]$release.nodeMajor -or $nodeAbi -ne [string]$release.nodeAbi) {
  throw "This package requires Node $($release.nodeMajor) ABI $($release.nodeAbi); found Node $nodeMajor ABI $nodeAbi."
}

if ((Test-Path -LiteralPath $targetRoot) -and $bundleRoot -ne $targetRoot) {
  try {
    Assert-BundleIntegrity $targetRoot
  } catch {
    if (-not $Force) {
      throw "The existing install is incomplete or modified. Re-run with -Force to replace: $targetRoot"
    }
    Assert-ChildPath $InstallRoot $targetRoot
    Remove-Item -LiteralPath $targetRoot -Recurse -Force
  }
}
if (-not (Test-Path -LiteralPath $targetRoot)) {
  New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
  Get-ChildItem -LiteralPath $bundleRoot -Force | Copy-Item -Destination $targetRoot -Recurse -Force
  Assert-BundleIntegrity $targetRoot
}

New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $targetRoot 'csm.env.example') `
  -Destination (Join-Path $ConfigRoot 'csm.env.example') -Force
if (-not $NoDefaultConfig) {
  $configPath = Join-Path $ConfigRoot '.env'
  if (-not (Test-Path -LiteralPath $configPath)) {
    $dataRoot = Get-FullPath (Join-Path (Split-Path $ConfigRoot -Parent) 'data')
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    $sqlitePath = (Join-Path $dataRoot 'csm.sqlite').Replace('\', '/')
    $config = @(
      'CSM_DATABASE_PROVIDER=sqlite',
      "CSM_SQLITE_PATH=$sqlitePath",
      'CSM_EMBEDDING_PROVIDER=ollama',
      'OLLAMA_HOST=http://127.0.0.1:11434',
      ''
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($configPath, $config, [System.Text.UTF8Encoding]::new($false))
  }
}

if ($CodexHome) {
  $CodexHome = Get-FullPath $CodexHome
  New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
  $env:CODEX_HOME = $CodexHome
}
$env:CSM_CONFIG_DIR = $ConfigRoot
$codex = Resolve-CodexExecutable $CodexExe
$marketplaceState = (& $codex plugin marketplace list --json | ConvertFrom-Json)
$existing = @($marketplaceState.marketplaces | Where-Object { $_.name -eq [string]$release.marketplaceName })
if ($existing.Count -gt 0) {
  & $codex plugin marketplace remove ([string]$release.marketplaceName) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to replace the existing CSM release marketplace.' }
}
& $codex plugin marketplace add $targetRoot --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to register the CSM release marketplace.' }
& $codex plugin add "$($release.pluginName)@$($release.marketplaceName)" --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to install the CSM plugin.' }

Write-Host "Installed Cross-Session Memory $($release.version)." -ForegroundColor Green
Write-Host "Plugin files: $targetRoot"
Write-Host "Configuration: $ConfigRoot"
Write-Host 'Fully restart Codex, review the plugin under /hooks, trust it, and start a fresh task.'
