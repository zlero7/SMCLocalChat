# 감시 (Windows): 5분마다 사이트·모델·공개 주소·디스크·백업을 확인하고, 멈췄으면 다시 켜고, 알림을 보낸다.
# 사용법: powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1   (작업 스케줄러 "chat-site 감시" 가 5분마다 실행)
#
# 알림: .env 에 ALERT_WEBHOOK_URL=<디스코드 또는 슬랙 웹훅 주소> 를 넣으면 문제가 생기거나 풀릴 때 메시지를 보낸다.
#       비워 두면 로그(D:\chat-site-data\watchdog.log)에만 남긴다.
# 한 번 실패했다고 바로 재시작하지 않는다 (2번 연속 실패해야 다시 켠다). 같은 문제로 알림을 계속 보내지도 않는다.

[Console]::OutputEncoding = [Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$dataDir = 'D:\chat-site-data'
$logFile = Join-Path $dataDir 'watchdog.log'
$stateFile = Join-Path $dataDir 'watchdog-state.json'

function Get-EnvValue($name, $default) {
  $line = Get-Content (Join-Path $root '.env') -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  $v = if ($line) { ($line -replace "^$name=", '').Trim() } else { '' }
  if ($v) { return $v } else { return $default }
}

$port = Get-EnvValue 'PORT' '4100'
$publicUrl = Get-EnvValue 'PUBLIC_URL' 'https://smcaichat.zlero.xyz'
$webhook = Get-EnvValue 'ALERT_WEBHOOK_URL' ''
$backupDir = Get-EnvValue 'BACKUP_DIR' 'C:\chat-site-backup'

function Write-Log($msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) { Move-Item $logFile "$logFile.old" -Force }
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch { }
}

function Send-Alert($msg) {
  Write-Log "알림: $msg"
  if (-not $webhook) { return }
  try {
    $body = @{ content = $msg; text = $msg } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $webhook -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 | Out-Null
  } catch { Write-Log "알림 보내기 실패: $($_.Exception.Message)" }
}

function Test-Url($url, $timeoutSec = 10) {
  try { return ((Invoke-WebRequest $url -UseBasicParsing -TimeoutSec $timeoutSec).StatusCode -eq 200) } catch { return $false }
}

# 지난번 상태 (연속 실패 횟수, 알림을 보낸 항목)
$state = @{ fails = @{}; alerted = @{} }
if (Test-Path $stateFile) {
  try {
    $old = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $old.fails.PSObject.Properties) { $state.fails[$p.Name] = [int]$p.Value }
    foreach ($p in $old.alerted.PSObject.Properties) { $state.alerted[$p.Name] = [bool]$p.Value }
  } catch { }
}

# 항목마다: 확인 → 실패 횟수 갱신 → 2번째 실패에 다시 켜고 알림 → 되살아나면 알림
function Check-Item($key, $label, [bool]$ok, $restartTask) {
  if ($ok) {
    if ($state.alerted[$key]) { Send-Alert "✅ $label 이(가) 다시 정상이에요." }
    $state.fails[$key] = 0
    $state.alerted[$key] = $false
    return
  }
  $n = 1 + [int]$state.fails[$key]
  $state.fails[$key] = $n
  Write-Log "$label 실패 ($n 번째)"
  if ($n -ge 2) {
    if ($restartTask) {
      try {
        Stop-ScheduledTask -TaskName $restartTask -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        Start-ScheduledTask -TaskName $restartTask -ErrorAction Stop
        Write-Log "'$restartTask' 작업을 다시 시작했어요"
      } catch { Write-Log "다시 시작 실패: $($_.Exception.Message)" }
    }
    if (-not $state.alerted[$key]) {
      $tail = if ($restartTask) { " 자동으로 다시 켜 봤어요." } else { '' }
      Send-Alert "⚠️ $label 에 문제가 있어요.$tail"
      $state.alerted[$key] = $true
    }
  }
}

# 1) 사이트 (이 PC 안에서)
$siteOk = Test-Url "http://127.0.0.1:$port/api/health"
Check-Item 'site' '사이트(서버)' $siteOk 'chat-site 사이트'

# 2) 모델 서버
Check-Item 'llama' '모델 서버(llama.cpp)' (Test-Url 'http://127.0.0.1:8081/health' 15) 'chat-site llama.cpp'

# 3) 공개 주소 (터널). 사이트 자체가 죽어 있으면 터널 탓이 아니니 건너뛴다
if ($siteOk) { Check-Item 'public' "공개 주소($publicUrl)" (Test-Url "$publicUrl/api/health" 15) 'chat-site 터널' }

# 4) 디스크 여유 (10GB 미만이면 알림)
foreach ($d in 'C', 'D') {
  $free = (Get-PSDrive $d -ErrorAction SilentlyContinue).Free
  if ($null -ne $free) { Check-Item "disk$d" "$d 드라이브 여유 공간(지금 $([math]::Round($free/1GB,1))GB)" ($free -gt 10GB) $null }
}

# 5) 백업이 36시간 안에 만들어졌는지
$latest = Get-ChildItem $backupDir -Filter 'chat-*.ndjson.gz' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$backupOk = [bool]($latest -and ((Get-Date) - $latest.LastWriteTime).TotalHours -lt 36)
Check-Item 'backup' '데이터베이스 백업(36시간 넘게 새로 안 만들어짐)' $backupOk $null

try { ($state | ConvertTo-Json -Depth 4) | Set-Content -Path $stateFile -Encoding UTF8 } catch { }
