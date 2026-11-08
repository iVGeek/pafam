# Install a Windows Scheduled Task that backs up the database daily at 02:00.
# Run as Administrator:  powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
# Remove with:           Unregister-ScheduledTask -TaskName "Perfumes Daily DB Backup" -Confirm:$false
$taskName = "Perfumes Daily DB Backup"
$repo = Split-Path -Parent $PSScriptRoot
$node = "$env:LOCALAPPDATA\..\..\" # placeholder, resolved below
$nodeExe = "C:\iVGeek\.nodetools\node-v24.20.0-win-x64\node.exe"
if (-not (Test-Path $nodeExe)) { $nodeExe = "node.exe" }
$script = Join-Path $repo "scripts\backup-db.js"
$backupDir = Join-Path $repo "data\backups"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 2:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Daily consistent SQLite backup of Perfumes (VACUUM INTO)" -Force | Out-Null
Write-Host "Installed $taskName (daily 02:00, backups to $backupDir)"
Write-Host "Note: the output filename is fixed per-run; keep last 30 with a cleanup policy, or change the argument to use today's date."
