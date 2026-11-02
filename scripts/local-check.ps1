# SyncPilot local validation for Windows PowerShell.
# Runs only local development checks. Does NOT install apps or modify Shopify stores.
param(
  [switch]$SkipInstall,
  [switch]$WithMigration
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot
$reportDir = Join-Path $repoRoot "local-check-results"
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null

$failed = New-Object 'System.Collections.Generic.List[string]'
$summary = New-Object 'System.Collections.Generic.List[string]'

function Run-Check {
  param([string]$Name, [string]$Command)
  $stdout = Join-Path $reportDir "$Name.stdout.log"
  $stderr = Join-Path $reportDir "$Name.stderr.log"

  Write-Host ""
  Write-Host "Running $Name ..." -ForegroundColor Cyan
  $process = Start-Process -FilePath $env:ComSpec `
    -ArgumentList @("/d", "/c", $Command) `
    -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr

  if ($process.ExitCode -eq 0) {
    Write-Host "PASS: $Name" -ForegroundColor Green
    $summary.Add("PASS $Name")
  } else {
    Write-Host "FAIL: $Name (exit $($process.ExitCode))" -ForegroundColor Red
    Write-Host "Review $stdout and $stderr"
    $failed.Add($Name)
    $summary.Add("FAIL $Name (exit $($process.ExitCode))")
  }
}

if (-not $SkipInstall) { Run-Check "npm-install" "npm ci" }
if ((Test-Path (Join-Path $repoRoot "node_modules")) -eq $false) {
  throw "node_modules is missing. Run without -SkipInstall."
}

Run-Check "prisma-generate" "npx prisma generate"
Run-Check "prisma-validate" "npx prisma validate"
Run-Check "typecheck" "npm run typecheck"
Run-Check "build" "npm run build"
if ($WithMigration) {
  Write-Host "Migration requires a running PostgreSQL database and local DATABASE_URL in .env."
  Run-Check "prisma-migrate" "npx prisma migrate deploy"
}

$summaryFile = Join-Path $reportDir "summary.txt"
$summary | Set-Content -Path $summaryFile -Encoding UTF8
Write-Host ""
Write-Host "Report: $summaryFile" -ForegroundColor Cyan
Write-Host "Check logs for secrets before sharing. NEVER send .env, Shopify API secret, access tokens, or database passwords." -ForegroundColor Yellow
if ($failed.Count -gt 0) {
  Write-Host ("Failed checks: " + ($failed -join ", ")) -ForegroundColor Red
  exit 1
}
Write-Host "All selected checks passed." -ForegroundColor Green
exit 0
