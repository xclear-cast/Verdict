$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
Set-Location $repoRoot

function Resolve-CodeCmd {
  $candidates = @(
    "code.cmd",
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles(x86)\Microsoft VS Code\bin\code.cmd"
  )

  foreach ($candidate in $candidates) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return $null
}

Write-Host "[1/4] Installing npm dependencies..."
npm.cmd install

Write-Host "[2/4] Building extension..."
npm.cmd run build:extension

Write-Host "[3/4] Packaging VSIX..."
npm.cmd run package:extension

$vsixPath = Join-Path $repoRoot "dist\multi-agent-debate.vsix"
if (-not (Test-Path $vsixPath)) {
  throw "VSIX file not found: $vsixPath"
}

$codeCmd = Resolve-CodeCmd
if (-not $codeCmd) {
  throw "VS Code CLI (code.cmd) not found. In VS Code run: Shell Command: Install 'code' command in PATH, then retry."
}

Write-Host "[4/4] Installing extension to VS Code..."
& $codeCmd --install-extension $vsixPath --force
if ($LASTEXITCODE -ne 0) {
  throw "VSIX install failed. code.cmd exit code: $LASTEXITCODE"
}

Write-Host ""
Write-Host "Installed successfully."
Write-Host "VSIX: $vsixPath"
Write-Host "Restart VS Code to load the updated extension."
