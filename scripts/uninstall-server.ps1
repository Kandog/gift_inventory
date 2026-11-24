<#
.SYNOPSIS
  Stops and removes the Gift Inventory startup task and firewall rule. Data (the data folder) is kept.
  Run in PowerShell opened with "Run as administrator":
      powershell -ExecutionPolicy Bypass -File scripts\uninstall-server.ps1
#>
param([int]$Port = 8080, [string]$TaskName = 'GiftInventory')
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task $TaskName."
}
# Stopping the task ends cmd.exe; make sure the node process it started is gone too.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*apps\server\src\main.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-NetFirewallRule -DisplayName "Gift Inventory (TCP $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Done. Your data folder was not touched.'
