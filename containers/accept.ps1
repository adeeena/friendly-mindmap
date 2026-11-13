<#
.SYNOPSIS
  Full-stack acceptance on a throwaway compose project: provisions an admin (default username 'adena') and a
  basic user with RANDOM throwaway passwords, runs the browser loop through nginx, restarts the whole stack,
  verifies persistence and removes everything it created.

.DESCRIPTION
  Never touches the default project/port: it uses a unique -p project name and a free random host port.
  Secrets exist only in a temp directory and process environment and are deleted at the end.
  Run from the repository root (Docker, Node and the built web dependencies are required):
    .\containers\accept.ps1
    .\containers\accept.ps1 -AdminUser adena -KeepStack   # leave the stack running for inspection
#>
param(
  [string]$AdminUser = 'adena',
  [switch]$KeepStack
)
$ErrorActionPreference = 'Continue' # native tools (docker) write progress to stderr; every call checks $LASTEXITCODE
$root = Split-Path -Parent $PSScriptRoot
$project = 'fm-final-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$tmp = Join-Path ([IO.Path]::GetTempPath()) $project
New-Item -ItemType Directory -Path $tmp | Out-Null

function New-Secret([int]$bytes = 24) { -join ((1..$bytes) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
function Get-FreePort {
  for ($try = 0; $try -lt 50; $try++) {
    $port = Get-Random -Minimum 17000 -Maximum 18999
    if (-not (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue)) { return $port }
  }
  throw 'No free port found'
}

$port = Get-FreePort
$adminPassword = New-Secret
$basicPassword = New-Secret
$envFile = Join-Path $tmp 'stack.env'
@(
  "POSTGRES_PASSWORD=$(New-Secret)", "S3_ACCESS_KEY=$(New-Secret 8)", "S3_SECRET_KEY=$(New-Secret)", "APP_PORT=$port"
) | Set-Content -Path $envFile
[IO.File]::WriteAllText((Join-Path $tmp 'admin_password'), $adminPassword)
$compose = @('compose', '-p', $project, '--env-file', $envFile, '-f', (Join-Path $root 'containers\docker-compose.yaml'))
$base = "http://127.0.0.1:$port"
$failed = $false

function Wait-Ready {
  $deadline = (Get-Date).AddMinutes(4)
  while ((Get-Date) -lt $deadline) {
    try { if ((Invoke-WebRequest -UseBasicParsing "$base/api/health/ready" -TimeoutSec 5).StatusCode -eq 200) { return } } catch { Start-Sleep 3 }
  }
  throw 'The stack did not become ready'
}

try {
  Write-Host "Project $project on $base"
  docker @compose up -d --build
  if ($LASTEXITCODE) { throw 'compose up failed' }
  Wait-Ready

  $env:ACCOUNT_USERNAME = $AdminUser
  docker @compose run --rm -v "$(Join-Path $tmp 'admin_password'):/run/secrets/account_password:ro" bootstrap-admin
  if ($LASTEXITCODE) { throw 'admin bootstrap failed' }
  Remove-Item Env:\ACCOUNT_USERNAME

  # The operator CLI only creates admins; a basic fixture is inserted with a hash made by the API's own code.
  Push-Location (Join-Path $root 'api')
  $env:HASH_INPUT = $basicPassword
  $hash = node -e "require('./dist/api/src/credentials').hashPassword(process.env.HASH_INPUT).then(h=>process.stdout.write(h))"
  Remove-Item Env:\HASH_INPUT
  Pop-Location
  "INSERT INTO users(id,username,display_name,password_hash,role) VALUES (gen_random_uuid(),'basic-fixture','Basic Fixture','$hash','basic');" |
    docker @compose exec -T postgres psql -U mindmap -d mindmap -v ON_ERROR_STOP=1
  if ($LASTEXITCODE) { throw 'basic fixture insert failed' }

  $env:STACK_URL = $base
  $env:STACK_ADMIN_USER = $AdminUser
  $env:STACK_ADMIN_PASSWORD = $adminPassword
  $env:STACK_BASIC_USER = 'basic-fixture'
  $env:STACK_BASIC_PASSWORD = $basicPassword
  $env:STACK_STATE_FILE = Join-Path $tmp 'state.json'
  Push-Location (Join-Path $root 'web')
  $env:STACK_PHASE = 'loop'
  npx playwright test --config playwright.stack.config.ts
  if ($LASTEXITCODE) { throw 'browser loop failed' }

  Write-Host 'Restarting the whole stack (volumes retained)...'
  docker @compose down
  docker @compose up -d
  if ($LASTEXITCODE) { throw 'restart failed' }
  Wait-Ready
  $env:STACK_PHASE = 'persisted'
  npx playwright test --config playwright.stack.config.ts
  if ($LASTEXITCODE) { throw 'persistence check failed' }
  Pop-Location
  Write-Host 'ACCEPTANCE PASSED'
}
catch {
  $failed = $true
  Write-Host "ACCEPTANCE FAILED: $($_.Exception.Message)"
}
finally {
  foreach ($name in 'STACK_URL', 'STACK_ADMIN_USER', 'STACK_ADMIN_PASSWORD', 'STACK_BASIC_USER', 'STACK_BASIC_PASSWORD', 'STACK_STATE_FILE', 'STACK_PHASE', 'ACCOUNT_USERNAME', 'HASH_INPUT') {
    Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
  }
  if (-not $KeepStack) {
    docker @compose down -v --remove-orphans 2>&1 | Out-Null
    docker image rm "$project-mindmap" 2>&1 | Out-Null
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  } else {
    Write-Host "Stack kept: project $project at $base (secrets in $tmp)"
  }
}
if ($failed) { exit 1 }
