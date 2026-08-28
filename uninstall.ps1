$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$installDir = Join-Path $env:LOCALAPPDATA 'PCPowerHistory'
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'PC Local Dashboard 自動記録.lnk'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PC Local Dashboard.lnk'
$pidPath = Join-Path $installDir 'app\dashboard.pid'
$storagePidPath = Join-Path $installDir 'app\storage-map\storage-map.pid'

Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'PC電気代自動記録.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'PC電気代を見る.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PCLocalDashboard' -Recurse -Force -ErrorAction SilentlyContinue
Get-Process -Name 'WattSeal' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $pidPath) {
    $dashboardPid = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue
    if ($dashboardPid -match '^\d+$') {
        $dashboardProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$dashboardPid" -ErrorAction SilentlyContinue
        if ($dashboardProcess -and $dashboardProcess.CommandLine -match 'PCPowerHistory.+server\.js') {
            Stop-Process -Id ([int]$dashboardPid) -Force -ErrorAction SilentlyContinue
        }
    }
}
if (Test-Path -LiteralPath $storagePidPath) {
    $storagePid = Get-Content -LiteralPath $storagePidPath -ErrorAction SilentlyContinue
    if ($storagePid -match '^\d+$') {
        $storageProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$storagePid" -ErrorAction SilentlyContinue
        if ($storageProcess -and $storageProcess.CommandLine -match 'storage-map.+server\.js') {
            Stop-Process -Id ([int]$storagePid) -Force -ErrorAction SilentlyContinue
        }
    }
}

$answer = Read-Host '記録データも含めて削除しますか？ (y/N)'
if ($answer -match '^(?i)y(es)?$') {
    if (Test-Path -LiteralPath $installDir) {
        Remove-Item -LiteralPath $installDir -Recurse -Force
    }
    Write-Host 'アプリと記録データを削除しました。'
} else {
    Write-Host "自動起動とショートカットだけ削除しました。記録データは $installDir に残っています。"
}
