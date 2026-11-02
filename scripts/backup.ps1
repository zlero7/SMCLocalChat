# 백업 (Windows): 데이터베이스를 파일 하나로 저장하고, 올린 파일(uploads)도 복사한다.
# 사용법: powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
# 보관 위치/기간은 .env 의 BACKUP_DIR(기본 C:\chat-site-backup), BACKUP_KEEP_DAYS(기본 14) 로 바꾼다.
# 데이터가 있는 D 드라이브와 다른 드라이브(C)에 두는 것이 기본이다. 한 디스크가 고장 나도 백업이 남도록.

[Console]::OutputEncoding = [Text.Encoding]::UTF8  # 한국어 안내가 깨지지 않게

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 예약 작업(시스템 계정)에서는 PATH 에 node 가 없을 수 있어 기본 설치 경로를 대신 쓴다
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

# .env 에서 필요한 값만 읽는다 (API 쪽 스크립트도 같은 .env 를 읽는다)
function Get-EnvValue($name, $default) {
  $line = Get-Content (Join-Path $root '.env') -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  $v = if ($line) { ($line -replace "^$name=", '').Trim() } else { '' }
  if ($v) { return $v } else { return $default }
}
$backupDir = Get-EnvValue 'BACKUP_DIR' 'C:\chat-site-backup'
$uploadDir = Get-EnvValue 'UPLOAD_DIR' (Join-Path $root 'data\uploads')

# 1) 데이터베이스 (실패하면 여기서 멈춘다)
& $node apps/api/dist/scripts/backup.js
if ($LASTEXITCODE -ne 0) { throw '데이터베이스 백업에 실패했어요.' }

# 2) 올린 파일: 새로 생기거나 바뀐 것만 복사한다 (지운 파일은 백업에 남겨 둔다)
if (Test-Path $uploadDir) {
  robocopy $uploadDir (Join-Path $backupDir 'uploads') /E /XO /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw '올린 파일 복사에 실패했어요.' }
  Write-Host "[backup] 올린 파일 복사 완료: $(Join-Path $backupDir 'uploads')"
}
