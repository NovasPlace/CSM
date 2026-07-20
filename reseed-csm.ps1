$ErrorActionPreference = "Stop"
$binDir = "C:\Program Files\PostgreSQL\18\bin"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Load DB password from .env (CSM_DATABASE_URL) — no hardcoded credentials
$envPath = Join-Path $scriptDir ".env"
$pgPass = ""
if (Test-Path $envPath) {
  $envContent = Get-Content $envPath -Raw
  if ($envContent -match "CSM_DATABASE_URL\s*=\s*postgresql://[^:]+:([^@]+)@") { $pgPass = $Matches[1] }
}
$env:PGPASSWORD = $pgPass

$docs = Join-Path $scriptDir "docs"
$sqlOut = "C:\Users\Donovan\AppData\Local\Temp\opencode\reseed.sql"
$sessionId = "ses_0822b7019ffeQ4UH67B43Z7dXP"

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("INSERT INTO sessions (id, project_id, created_at) VALUES ('$sessionId','cross-session-memory', now()) ON CONFLICT (id) DO NOTHING;")

$rows = @()
function Add-Row { param($type,$path,$importance,$emotion,$tags)
  $script:rows += [pscustomobject]@{ type=$type; path=$path; importance=$importance; emotion=$emotion; tags=$tags }
}
Add-Row "repo"        "AGENT_MEMORY.md"        0.8 "neutral" @("repo","system-map","csm-architecture")
Add-Row "repo"        "ARCHITECTURE.md"        0.7 "neutral" @("repo","architecture")
Add-Row "repo"        "PRODUCT_ARCHITECTURE.md" 0.6 "neutral" @("repo","product")
Add-Row "procedural"  "RUNBOOK.md"             0.75 "neutral" @("runbook","ops")
Add-Row "procedural"  "TROUBLESHOOTING.md"     0.75 "neutral" @("troubleshooting","ops")
Add-Row "procedural"  "DEBUG_NOTES.md"         0.7 "neutral" @("debug","ops")
Add-Row "episodic"    "PHASE_HISTORY.md"       0.5 "neutral" @("phase-history","roadmap")
Add-Row "repo"        "COORDINATION_FABRIC_CONTRACT.md" 0.6 "neutral" @("contract","design")
Add-Row "repo"        "COORDINATION_PERSISTENCE_CONTRACT.md" 0.6 "neutral" @("contract","design")
Add-Row "repo"        "DATA_PRIVACY_AND_LIFECYCLE.md" 0.6 "neutral" @("privacy","lifecycle")
Add-Row "repo"        "ENTERPRISE_READINESS.md" 0.6 "neutral" @("enterprise")
Add-Row "repo"        "FEATURES.md"            0.6 "neutral" @("features")

$count = 0
foreach ($r in $rows) {
  $fp = Join-Path $docs $r.path
  if (-not (Test-Path $fp)) { continue }
  $content = Get-Content $fp -Raw
  if (-not $content -or $content.Trim().Length -lt 20) { continue }
  $tagsLit = "ARRAY[" + (($r.tags | ForEach-Object { "'$_'" }) -join ",") + "]::text[]"
  $tag = "SEED$count"; $dq = "`$$tag`$"
  [void]$sb.AppendLine("INSERT INTO memories (session_id, project_id, memory_type, content, importance, emotion, confidence, source, tags, metadata, created_at) VALUES ('$sessionId','cross-session-memory','$($r.type)',$dq$content$dq,$($r.importance),'$($r.emotion)',0.9,'reseed',$tagsLit,'{`"seedSource`":`"docs-reseed`",`"file`":`"$($r.path)`"}'::jsonb, now());")
  $count++
}
$decPath = Join-Path $docs "DECISIONS.md"
if (Test-Path $decPath) {
  $dec = Get-Content $decPath -Raw
  $sections = $dec -split "(?m)^## " | Where-Object { $_.Trim().Length -gt 40 }
  foreach ($s in $sections) {
    $body = ("## " + $s).Trim()
    $tag = "SEED$count"; $dq = "`$$tag`$"
    [void]$sb.AppendLine("INSERT INTO memories (session_id, project_id, memory_type, content, importance, emotion, confidence, source, tags, metadata, created_at) VALUES ('$sessionId','cross-session-memory','conversation',$dq$body$dq,0.7,'neutral',0.9,'reseed',ARRAY['decision','architecture-decision']::text[],'{`"seedSource`":`"docs-reseed`",`"file`":`"DECISIONS.md`"}'::jsonb, now());")
    $count++
  }
}
Set-Content -LiteralPath $sqlOut -Value $sb.ToString() -Encoding UTF8
"SQL rows prepared: $count -> $sqlOut ($([math]::Round((Get-Item $sqlOut).Length/1KB,1)) KB)"
