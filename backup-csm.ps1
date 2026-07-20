$ErrorActionPreference = "Stop"
$binDir = "C:\Program Files\PostgreSQL\18\bin"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Load DB connection from .env (CSM_DATABASE_URL) — no hardcoded credentials
$envPath = Join-Path $scriptDir ".env"
$pgUser = "postgres"; $pgPass = ""; $pgHost = "localhost"; $pgPort = "5432"; $pgDb = "csmdb"
if (Test-Path $envPath) {
  $envContent = Get-Content $envPath -Raw
  if ($envContent -match "CSM_DATABASE_URL\s*=\s*postgresql://([^:]+):([^@]+)@([^:/]+):?(\d*)/(\w+)") {
    $pgUser = $Matches[1]; $pgPass = $Matches[2]; $pgHost = $Matches[3]
    if ($Matches[4]) { $pgPort = $Matches[4] }; $pgDb = $Matches[5]
  }
}
$conn = "postgresql://$pgUser`:$pgPass@$pgHost`:$pgPort/$pgDb"
$env:PGPASSWORD = $pgPass
$backupRoot = "C:\Users\Donovan\Documents\Work\cross-session-memory\.csm-backups"
$ts    = Get-Date -Format "yyyy-MM-dd_HH-mm"
$pgDir = Join-Path $backupRoot "pgdump"
$mdDir = Join-Path $backupRoot "wiki-md"
New-Item -ItemType Directory -Force -Path $pgDir, $mdDir | Out-Null

# 1) pg_dump full gzipped
$ms = New-Object System.IO.MemoryStream
$sw = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Compress)
$bw = New-Object System.IO.StreamWriter($sw)
$plain = & "$binDir\pg_dump.exe" --dbname $conn --clean --if-exists --no-owner --format=plain 2>&1
$bw.Write($plain); $bw.Close()
$dumpFile = Join-Path $pgDir "csmdb_$ts.sql.gz"
[System.IO.File]::WriteAllBytes($dumpFile, $ms.ToArray())

# 2) markdown mirror (portable, no plugin internals needed)
$rows = & "$binDir\psql.exe" $conn -t -A -F "`t" -c "SELECT id, memory_type, emotion, importance, tags::text, content FROM memories ORDER BY id;" 2>&1
$rows = $rows | Where-Object { $_ -and $_.Trim().Length -gt 0 }
$idx = @()
$i = 0
foreach ($r in $rows) {
  $f = $r -split "`t", 6
  if ($f.Count -lt 6) { continue }
  $id = $f[0]; $type = $f[1]; $emotion = $f[2]; $imp = $f[3]; $tags = $f[4]; $content = $f[5]
  $slug = "mem-$id"
  $fm = "---`ntype: $type`nemotion: $emotion`nimportance: $imp`ntags: $tags`nid: $id`n---`n`n" + $content
  $fn = Join-Path $mdDir "$slug.md"
  [System.IO.File]::WriteAllText($fn, $fm, [System.Text.Encoding]::UTF8)
  $idx += "- [$type] mem-$id.md — " + ($content.Split("`n")[0].Substring(0, [Math]::Min(80, $content.Split("`n")[0].Length)))
  $i++
}
[System.IO.File]::WriteAllText((Join-Path $mdDir "INDEX.md"), ($idx -join "`n"), [System.Text.Encoding]::UTF8)

# prune dumps
Get-ChildItem $pgDir -Filter "csmdb_*.sql.gz" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Output "Backup complete: $dumpFile ; markdown: $i files in $mdDir"

