$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $sourceDir 'setup-log.txt'

function Write-SetupLog {
    param([string]$Level, [string]$Message)
    $clean = [regex]::Replace([string]$Message, '\s+', ' ').Trim()
    if ($clean.Length -gt 240) { $clean = $clean.Substring(0, 237) + '...' }
    $line = '[{0}][{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $clean
    try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch {}
}

try { Set-Content -LiteralPath $logPath -Value '' -Encoding UTF8 } catch {}
Write-SetupLog 'INFO' 'セットアップを開始しました。'

trap {
    Write-Host ''
    $message = [regex]::Replace([string]$_.Exception.Message, '\s+', ' ').Trim()
    Write-SetupLog 'ERROR' $message
    Write-Host ('[エラー] ' + $message) -ForegroundColor Red
    Write-Host ('詳しいログ: ' + $logPath)
    exit 1
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$installDir = Join-Path $env:LOCALAPPDATA 'PCPowerHistory'
$appDir = Join-Path $installDir 'app'

function Stop-DashboardProcess {
    $pidPath = Join-Path $appDir 'dashboard.pid'
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return
    }

    $dashboardPid = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue
    if ($dashboardPid -notmatch '^\d+$') {
        return
    }

    $dashboardProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$dashboardPid" -ErrorAction SilentlyContinue
    if ($dashboardProcess -and $dashboardProcess.CommandLine -match 'PCPowerHistory.+server\.js') {
        Stop-Process -Id ([int]$dashboardPid) -Force -ErrorAction SilentlyContinue
    }
}

function Stop-StorageProcess {
    $pidPath = Join-Path $appDir 'storage-map\storage-map.pid'
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return
    }

    $storagePid = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue
    if ($storagePid -notmatch '^\d+$') {
        return
    }

    $storageProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$storagePid" -ErrorAction SilentlyContinue
    if ($storageProcess -and $storageProcess.CommandLine -match 'storage-map.+server\.js') {
        Stop-Process -Id ([int]$storagePid) -Force -ErrorAction SilentlyContinue
    }
}

function Stop-WattSealProcess {
    $targetPath = [System.IO.Path]::GetFullPath((Join-Path $appDir 'WattSeal.exe'))
    $processIds = @(Get-CimInstance Win32_Process -Filter "Name='WattSeal.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $targetPath } |
        Select-Object -ExpandProperty ProcessId)
    $processes = @($processIds | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($processes.Count -eq 0) {
        return
    }

    $processIds = @($processes | ForEach-Object { $_.Id })
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue

    # Stop-Processが返った直後でも、Windows側でEXEのハンドルが残る場合がある。
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $remaining = @($processIds | Where-Object {
            Get-Process -Id $_ -ErrorAction SilentlyContinue
        })
        if ($remaining.Count -eq 0) {
            break
        }
        Start-Sleep -Milliseconds 200
    }

    $remaining = @($processIds | Where-Object {
        Get-Process -Id $_ -ErrorAction SilentlyContinue
    })
    foreach ($processId in $remaining) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $processId /T /F 2>$null | Out-Null
    }

    if ($remaining.Count -gt 0) {
        Start-Sleep -Milliseconds 500
    }
}

Write-Host 'PC Local Dashboardをセットアップします。'

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.jsが見つかりません。Node.js 22.5以降をインストールしてから、もう一度実行してください。'
}

$nodeVersionText = (& $nodeCommand.Source --version).Trim().TrimStart('v')
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]'22.5.0') {
    throw "Node.js 22.5以降が必要です。現在: $nodeVersionText"
}
Write-Host ("[OK] Node.js $nodeVersionText")
Write-SetupLog 'OK' ("Node.js $nodeVersionTextを確認しました。")

$configPath = Join-Path $appDir 'config.json'
$savedConfig = $null
if (Test-Path -LiteralPath $configPath) {
    $savedConfig = Get-Content -LiteralPath $configPath -Raw
}

Stop-DashboardProcess
Stop-StorageProcess

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -Path (Join-Path $sourceDir 'app\*') -Destination $appDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'uninstall.ps1') -Destination (Join-Path $installDir 'uninstall.ps1') -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'アンインストール.cmd') -Destination (Join-Path $installDir 'アンインストール.cmd') -Force
[System.IO.File]::WriteAllText(
    (Join-Path $appDir 'node-path.txt'),
    $nodeCommand.Source,
    [System.Text.Encoding]::Unicode
)
$storageMapDir = Join-Path $appDir 'storage-map'
if (Test-Path -LiteralPath $storageMapDir) {
    [System.IO.File]::WriteAllText(
        (Join-Path $storageMapDir 'node-path.txt'),
        $nodeCommand.Source,
        [System.Text.Encoding]::Unicode
    )
}
Write-Host '[OK] アプリ本体を配置しました。'
Write-SetupLog 'OK' 'アプリ本体を配置しました。'

if ($null -ne $savedConfig) {
    Set-Content -LiteralPath $configPath -Value $savedConfig -Encoding UTF8
}
if (-not (Test-Path -LiteralPath $configPath)) {
    @{
        electricityRate = 31
        sensorFactor = 1.10
        baseWatts = 25
        monitorWatts = 0
        monthlyBudget = 0
        lanAccess = $false
        gameKeywords = @('steam', 'epicgames', 'riotclient', 'valorant', 'apex', 'genshin', 'terraria', 'edf', 'earthdefenseforce', 'darkanddarker', 'mgs', 'metalgear')
    } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
}

$wattSealPath = Join-Path $appDir 'WattSeal.exe'
Write-Host '検証済みの計測エンジン WattSeal v1.0.2を公式GitHubから取得しています...'
Write-SetupLog 'INFO' 'WattSeal v1.0.2の公式配布ファイルを確認しています。'
$headers = @{ 'User-Agent' = 'PCPowerHistory-Setup' }
$downloadUrl = 'https://github.com/Daminoup88/WattSeal/releases/download/v1.0.2/WattSeal-windows.exe'
$expectedHash = 'd5b4f06020c8cb2eb8b0930d56a597787d0798234538deadc6f32b4a56d0d483'
$apiFailed = $false
$apiDigestMismatch = $false
try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/Daminoup88/WattSeal/releases/tags/v1.0.2' -Headers $headers
    $asset = $release.assets |
        Where-Object { $_.name -match '(?i)windows.*\.exe$' } |
        Select-Object -First 1
    if ($asset) {
        if ($asset.digest -and $asset.digest -match '^sha256:(.+)$' -and $Matches[1].ToLowerInvariant() -ne $expectedHash) {
            $apiDigestMismatch = $true
        } else {
            $downloadUrl = $asset.browser_download_url
            Write-Host ('[OK] Release asset: ' + $asset.name)
            Write-SetupLog 'OK' ('公式Releaseの配布名を確認しました: ' + $asset.name)
        }
    }
} catch {
    $apiFailed = $true
}
if ($apiDigestMismatch) {
    throw '公式ReleaseのSHA-256が固定値と一致しません。'
}
if ($apiFailed) {
    Write-Host '[注意] GitHub APIを取得できないため、公式の固定URLから取得します。'
    Write-SetupLog 'WARN' 'GitHub APIに接続できないため、固定URLを使用します。固定SHA-256は引き続き検証します。'
}

$downloadPath = Join-Path $env:TEMP ('PCPowerHistory-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -Headers $headers -OutFile $downloadPath
    if ((Get-Item -LiteralPath $downloadPath).Length -lt 100000) {
        throw 'ダウンロードしたファイルが小さすぎます。'
    }
    $downloadHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadHash -ne $expectedHash) {
        throw 'WattSealのSHA-256が一致しません。'
    }
    Write-SetupLog 'OK' 'WattSealのSHA-256検証に成功しました。'

    $installed = $false
    if (Test-Path -LiteralPath $wattSealPath) {
        try {
            $installedHash = (Get-FileHash -LiteralPath $wattSealPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($installedHash -eq $downloadHash) {
                $installed = $true
                Write-Host '[OK] 既存の計測エンジンは同じv1.0.2のため、そのまま使用します。'
            }
        } catch {}
    }

    if (-not $installed) {
        Stop-WattSealProcess
        for ($copyAttempt = 1; $copyAttempt -le 15; $copyAttempt++) {
            try {
                [System.IO.File]::Copy($downloadPath, $wattSealPath, $true)
                $installed = $true
                break
            } catch [System.IO.IOException] {
                if ($copyAttempt -eq 15) { throw }
                Start-Sleep -Milliseconds 400
            } catch [System.UnauthorizedAccessException] {
                if ($copyAttempt -eq 15) { throw }
                Start-Sleep -Milliseconds 400
            }
        }
    }
    if (-not $installed) {
        throw 'WattSeal.exeを配置できませんでした。'
    }
    if (Test-Path -LiteralPath $wattSealPath) {
        $finalHash = (Get-FileHash -LiteralPath $wattSealPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($finalHash -ne $downloadHash) {
            throw '配置後のWattSeal.exeを検証できませんでした。'
        }
    } else {
        throw '配置後のWattSeal.exeが見つかりません。'
    }
    Write-Host '[OK] 計測エンジンを取得しました。'
    Write-SetupLog 'OK' 'WattSeal v1.0.2を配置しました。'
}
finally {
    Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
}

$shell = New-Object -ComObject WScript.Shell
$startupDir = [Environment]::GetFolderPath('Startup')
Remove-Item -LiteralPath (Join-Path $startupDir 'PC電気代自動記録.lnk') -Force -ErrorAction SilentlyContinue
$startupShortcut = $shell.CreateShortcut((Join-Path $startupDir 'PC Local Dashboard 自動記録.lnk'))
$startupShortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$startupShortcut.Arguments = '"' + (Join-Path $appDir 'background.vbs') + '"'
$startupShortcut.WorkingDirectory = $appDir
$startupShortcut.Description = 'PC消費電力を自動記録します'
$startupShortcut.Save()

$desktopDir = [Environment]::GetFolderPath('Desktop')
Remove-Item -LiteralPath (Join-Path $desktopDir 'PC電気代を見る.lnk') -Force -ErrorAction SilentlyContinue
$dashboardShortcut = $shell.CreateShortcut((Join-Path $desktopDir 'PC Local Dashboard.lnk'))
$dashboardShortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$dashboardShortcut.Arguments = '"' + (Join-Path $appDir 'dashboard.vbs') + '"'
$dashboardShortcut.WorkingDirectory = $appDir
$dashboardShortcut.Description = '電力・容量・PC状態を表示します'
$dashboardShortcut.IconLocation = "$env:SystemRoot\System32\powercpl.dll,0"
$dashboardShortcut.Save()

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PCLocalDashboard'
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name DisplayName -Value 'PC Local Dashboard'
Set-ItemProperty -Path $uninstallKey -Name DisplayVersion -Value '0.11.0'
Set-ItemProperty -Path $uninstallKey -Name Publisher -Value 'PC Local Dashboard contributors'
Set-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $installDir
Set-ItemProperty -Path $uninstallKey -Name DisplayIcon -Value "$env:SystemRoot\System32\powercpl.dll"
Set-ItemProperty -Path $uninstallKey -Name UninstallString -Value ('"' + $env:SystemRoot + '\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $installDir 'uninstall.ps1') + '"')
Set-ItemProperty -Path $uninstallKey -Name NoModify -Type DWord -Value 1
Set-ItemProperty -Path $uninstallKey -Name NoRepair -Type DWord -Value 1
Write-Host '[OK] 自動起動、デスクトップアイコン、アンインストール情報を設定しました。'
Write-SetupLog 'OK' '自動起動、ショートカット、アンインストール情報を設定しました。'

$collectorAlreadyRunning = [bool](Get-Process -Name 'WattSeal' -ErrorAction SilentlyContinue)
if (-not $collectorAlreadyRunning) {
    Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('"' + (Join-Path $appDir 'background.vbs') + '"')
}
Write-Host '計測エンジンの起動を確認しています。初回のみWindowsの確認画面が出る場合があります。'
$collectorStarted = $false
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Seconds 1
    if (Get-Process -Name 'WattSeal' -ErrorAction SilentlyContinue) {
        $collectorStarted = $true
        break
    }
}
if (-not $collectorStarted) {
    throw 'WattSealを起動できませんでした。Windows DefenderまたはSmartScreenの確認画面を確認してください。'
}
Write-Host '[OK] 自動記録プロセスが動作しています。'
Write-SetupLog 'OK' '自動記録プロセスが動作しています。'

Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('"' + (Join-Path $appDir 'dashboard.vbs') + '"')

Write-Host ''
Write-Host 'セットアップ完了。以後はWindows起動時に自動記録されます。'
Write-Host '確認するときは、デスクトップの「PC Local Dashboard」を開いてください。'
Write-SetupLog 'DONE' 'セットアップが完了しました。'
exit 0
