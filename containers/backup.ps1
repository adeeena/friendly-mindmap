<#
.SYNOPSIS
  Coherent offline-quiesced backup of the PostgreSQL database and the RustFS attachment data.

.DESCRIPTION
  Stops the application and API so no write, upload or cleanup runs, dumps PostgreSQL
  (custom format), stops RustFS and archives its data volume, writes SHA-256 checksums, then
  restarts the stack. Database and objects therefore describe the same moment.
  Secrets are never written to the backup directory, but the backup contains all user data:
  protect it accordingly. Keep your own copy of containers/.env separately.

.EXAMPLE
  .\containers\backup.ps1 -OutDir D:\backups\mindmap-2026-01-01
  .\containers\backup.ps1 -Project fm-prod -EnvFile D:\secrets\mindmap.env -OutDir D:\backups\x
#>
param(
  [Parameter(Mandatory)][string]$OutDir,
  [string]$Project,
  [string]$EnvFile,
  [string]$ComposeFile = (Join-Path $PSScriptRoot 'docker-compose.yaml')
)
$ErrorActionPreference = 'Stop'

$compose = @('compose', '-f', $ComposeFile)
if ($Project) { $compose += @('-p', $Project) }
if ($EnvFile) { $compose += @('--env-file', $EnvFile) }

function Invoke-Docker {
  # docker writes progress to stderr; do not let that terminate the script.
  $ErrorActionPreference = 'Continue'
  & docker @args 2>&1 | ForEach-Object { Write-Host "$_" }
  if ($LASTEXITCODE -ne 0) { throw "docker $($args -join ' ') failed with exit code $LASTEXITCODE" }
}

function Get-DockerOutput {
  $ErrorActionPreference = 'Continue'
  $output = & docker @args 2>$null
  if ($LASTEXITCODE -ne 0) { throw "docker $($args -join ' ') failed with exit code $LASTEXITCODE" }
  $output
}

if (Test-Path -LiteralPath $OutDir) {
  if (Get-ChildItem -LiteralPath $OutDir -Force | Select-Object -First 1) { throw "OutDir '$OutDir' must be empty." }
} else {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

$volume = (Get-DockerOutput volume ls --filter "label=com.docker.compose.project=$(if ($Project) { $Project } else { Split-Path -Leaf $PSScriptRoot })" `
  --filter 'label=com.docker.compose.volume=rustfs-data' -q) | Select-Object -First 1
if (-not $volume) { throw 'RustFS data volume not found; check -Project.' }
$helper = 'postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'

try {
  Write-Host 'Quiescing: stopping application and API'
  Invoke-Docker @compose stop mindmap api
  Invoke-Docker @compose up -d --wait postgres

  Write-Host 'Dumping PostgreSQL'
  Invoke-Docker @compose exec -T postgres pg_dump -U mindmap -d mindmap -Fc -f /tmp/mindmap.dump
  Invoke-Docker @compose cp postgres:/tmp/mindmap.dump (Join-Path $OutDir 'postgres.dump')
  Invoke-Docker @compose exec -T postgres rm -f /tmp/mindmap.dump

  Write-Host 'Archiving RustFS data (storage stopped)'
  Invoke-Docker @compose stop rustfs
  Invoke-Docker run --rm --entrypoint tar -v "${volume}:/data:ro" -v "${OutDir}:/backup" $helper -czf /backup/rustfs-data.tar.gz -C /data .
} finally {
  Write-Host 'Restarting stack'
  Invoke-Docker @compose up -d --wait
}

$lines = foreach ($name in 'postgres.dump', 'rustfs-data.tar.gz') {
  '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $OutDir $name)).Hash.ToLower(), $name
}
[IO.File]::WriteAllLines((Join-Path $OutDir 'SHA256SUMS'), $lines)
Write-Host "Backup complete: $OutDir"
