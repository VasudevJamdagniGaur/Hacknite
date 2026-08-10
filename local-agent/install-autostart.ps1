# Install Veritas local agent to start with Windows (keeps AEGIS/VideoMAE on :5051).
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat = Join-Path $here "start.bat"
$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "Veritas Local Agent.lnk"

$w = New-Object -ComObject WScript.Shell
$sc = $w.CreateShortcut($shortcutPath)
$sc.TargetPath = $bat
$sc.WorkingDirectory = $here
$sc.WindowStyle = 7
$sc.Description = "Keeps Veritas AEGIS + VideoMAE video-detector running for the Chrome extension"
$sc.Save()

Write-Host "Installed Startup shortcut: $shortcutPath"

# Start now if not already listening
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:5060/health" -UseBasicParsing -TimeoutSec 2
  Write-Host "Local agent already running."
} catch {
  Start-Process -FilePath $bat -WorkingDirectory $here
  Write-Host "Started Veritas local agent."
}

Write-Host "Done. Extension Check AI will use http://127.0.0.1:5051 automatically."
