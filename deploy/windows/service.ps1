# MUSICH on Windows: background start via Task Scheduler (at boot, even before anyone logs in)
# and a firewall rule so phones on the home network can reach the server.
# The server runs as the person who installed it, without admin rights (S4U, no password stored):
# it sees that person's files and nothing more. If Windows refuses that logon, it falls back to the next account.
# Called by the installer: install | uninstall | stop | start
param([ValidateSet('install', 'uninstall', 'stop', 'start')][string]$Action = 'install')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'MUSICH'
$node = Join-Path $root 'node.exe'

function Stop-Musich {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  # the launcher and the server are both node.exe from this folder
  Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

function Remove-Rule {
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

switch ($Action) {
  'install' {
    Stop-Musich
    $act = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $root 'launcher.mjs') + '"') -WorkingDirectory $root
    $trg = New-ScheduledTaskTrigger -AtStartup
    # no time limit (default is 3 days), keep running on battery, restart if it dies
    $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    # home and work networks only: on public Wi-Fi (cafe, airport) the server stays closed to others
    Remove-Rule
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Program $node -Action Allow -Profile Private, Domain | Out-Null
    $data = Join-Path $env:ProgramData 'MUSICH'
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    # who sits at this PC (even if setup was elevated with another admin's password), else who runs setup
    $who = @((Get-CimInstance Win32_ComputerSystem).UserName, [Security.Principal.WindowsIdentity]::GetCurrent().Name) |
      Where-Object { $_ } | Select-Object -Unique
    $ok = $false
    foreach ($user in @($who) + 'SYSTEM') {
      $sid = $null
      if ($user -eq 'SYSTEM') {
        $pr = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      } else {
        try { $sid = (New-Object Security.Principal.NTAccount($user)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { continue }
        $pr = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
      }
      # data (database, sign-ins, logs): only SYSTEM, Administrators and the server's own user; other accounts see nothing
      $grant = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
      if ($sid) { $grant += "*${sid}:(OI)(CI)M" }
      & icacls.exe $data /inheritance:r /grant:r @grant /Q | Out-Null
      & icacls.exe (Join-Path $data '*') /reset /T /C /Q 2>$null | Out-Null
      Register-ScheduledTask -TaskName $name -Action $act -Trigger $trg -Settings $set -Principal $pr `
        -Description 'MUSICH music server' -Force | Out-Null
      Start-ScheduledTask -TaskName $name
      # wait until the server answers, so the window opened by the installer does not show an error
      for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
        try {
          Invoke-WebRequest -Uri 'http://127.0.0.1:2290/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null
          $ok = $true
        } catch {
          $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
          # 0x80070569: this account may not run background tasks; 0x8007052E: logon failure → try the next one
          if ($info -and @(-2147023511, -2147023570) -contains $info.LastTaskResult) { break }
          Start-Sleep -Milliseconds 500
        }
      }
      if ($ok) { break }
      Stop-Musich
    }
  }
  'uninstall' {
    Stop-Musich
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Rule
  }
  'stop' { Stop-Musich }
  'start' { Start-ScheduledTask -TaskName $name }
}
