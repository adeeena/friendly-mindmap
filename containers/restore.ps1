<#
.SYNOPSIS
  Restores a backup made by backup.ps1 into an empty (new or isolated) stack.

.DESCRIPTION
  Creates the stack's volumes, restores the PostgreSQL dump and the RustFS data archive while
  the API and storage are stopped, then starts the whole stack (migrations are repeatable and
  find the schema already current). Refuses to proceed when the target database is not empty
  unless -Force is given; the RustFS data volume is then replaced entirely by the archive.
  Use a different -Project (and APP_PORT) to restore beside a running stack for verification.

.EXAMPLE
  .\containers\restore.ps1 -BackupDir D:\backups\mindmap-2026-01-01 -Project fm-restore -EnvFile D:\secrets\restore.env
#>
param(
  [Parameter(Mandatory)][string]$BackupDir,
  [string]$Project,
  [string]$EnvFile,
  [string]$ComposeFile = (Join-Path $PSScriptRoot 'docker-compose.yaml'),
  [switch]$Force
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

$BackupDir = (Resolve-Path -LiteralPath $BackupDir).Path
foreach ($line in Get-Content -LiteralPath (Join-Path $BackupDir 'SHA256SUMS')) {
  $expected, $name = $line -split '\s+', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $BackupDir $name)).Hash.ToLower()
  if ($actual -ne $expected) { throw "Checksum mismatch for $name; the backup is damaged." }
}
Write-Host 'Backup checksums verified'

$projectName = if ($Project) { $Project } else { Split-Path -Leaf $PSScriptRoot }
$helper = 'postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'

# Build the image first so the one-shot services can use it, then create (not start) the volumes.
Invoke-Docker @compose build --quiet api
Invoke-Docker @compose stop mindmap api
Invoke-Docker @compose create postgres rustfs
$volume = (Get-DockerOutput volume ls --filter "label=com.docker.compose.project=$projectName" `
  --filter 'label=com.docker.compose.volume=rustfs-data' -q) | Select-Object -First 1
if (-not $volume) { throw 'RustFS data volume was not created.' }

Invoke-Docker @compose up -d --wait postgres
$tables = (Get-DockerOutput @compose exec -T postgres psql -U mindmap -d mindmap -Atc "select count(*) from information_schema.tables where table_schema='public'").Trim()
if ([int]$tables -gt 0 -and -not $Force) { throw 'Target database is not empty. Use an empty/isolated project, or pass -Force to overwrite it.' }

Write-Host 'Restoring PostgreSQL'
Invoke-Docker @compose cp (Join-Path $BackupDir 'postgres.dump') postgres:/tmp/restore.dump
Invoke-Docker @compose exec -T postgres pg_restore -U mindmap -d mindmap --single-transaction --exit-on-error --clean --if-exists --no-owner /tmp/restore.dump
Invoke-Docker @compose exec -T postgres rm -f /tmp/restore.dump

Write-Host 'Restoring RustFS data (storage stopped)'
Invoke-Docker @compose stop rustfs
Invoke-Docker run --rm --entrypoint sh -v "${volume}:/data" -v "${BackupDir}:/backup:ro" $helper -c 'find /data -mindepth 1 -delete && tar -xzf /backup/rustfs-data.tar.gz -C /data'

Write-Host 'Starting stack'
Invoke-Docker @compose up -d --wait
Write-Host 'Restore complete. Sign in and verify a board, its history and an attachment.'
