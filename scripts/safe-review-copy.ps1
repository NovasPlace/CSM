param(
  [string]$ReviewRoot = (Join-Path $env:TEMP ('opencode-csm-review-' + [guid]::NewGuid().ToString('N'))),
  [switch]$Archive
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'git is required.'
}

Write-Host "Creating detached worktree at $ReviewRoot"
git worktree add --detach $ReviewRoot HEAD | Out-Host

if ($Archive) {
  $zipPath = Join-Path $ReviewRoot 'repo.zip'
  Write-Host "Writing archive to $zipPath"
  git archive --format=zip --output $zipPath HEAD | Out-Host
}

Write-Host $ReviewRoot
