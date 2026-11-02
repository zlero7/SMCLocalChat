# 사이트 실행 (Windows, 배포 모드): 데이터베이스를 켜고, API 서버가 빌드된 화면까지 같이 내보낸다.
# 사용법: powershell -ExecutionPolicy Bypass -File scripts\start-site.ps1
#   먼저 npm run build 로 빌드해 두어야 한다. 주소는 http://localhost:<.env 의 PORT>
# 데이터베이스 위치는 아래 기본값이나 환경 변수 CHAT_PG_HOME, CHAT_PG_DATA 로 바꾼다.

[Console]::OutputEncoding = [Text.Encoding]::UTF8  # 한국어 안내가 깨지지 않게

function Get-Setting($name, $default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($v)) { return $default } else { return $v }
}

$root   = Split-Path -Parent $PSScriptRoot
$pgHome = Get-Setting 'CHAT_PG_HOME' 'D:\chat-site-data\pgsql'
$pgData = Get-Setting 'CHAT_PG_DATA' 'D:\chat-site-data\pgdata'
$pgPort = Get-Setting 'CHAT_PG_PORT' '54329'  # .env 의 DATABASE_URL 포트와 같게

# 1) 데이터베이스: 이미 켜져 있으면 그대로 둔다
#    (postgres 는 관리자 권한으로 직접 실행하면 거부하므로 pg_ctl 로 켠다. pg_ctl 이 권한을 낮춰 실행해 준다)
& "$pgHome\bin\pg_ctl.exe" status -D $pgData *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "데이터베이스 시작: $pgData (포트 $pgPort)"
  & "$pgHome\bin\pg_ctl.exe" start -D $pgData -o "-p $pgPort" -l "$pgData\..\postgres.log" -w -t 120
  if ($LASTEXITCODE -ne 0) { throw '데이터베이스를 켜지 못했어요. postgres.log 를 확인하세요.' }
}

# 2) API 서버 (배포 모드, 화면도 같이 제공). .env 보다 여기 값이 먼저 적용된다
$env:NODE_ENV = 'production'
$env:SERVE_WEB = 'true'
Set-Location $root
# 예약 작업(시스템 계정)에서는 PATH 에 node 가 없을 수 있어 기본 설치 경로를 대신 쓴다
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
Write-Host '사이트 시작'
& $node apps/api/dist/index.js
# 프로그램이 비정상으로 끝났으면 그 종료 코드를 그대로 돌려줘야 작업 스케줄러가 1분 뒤 다시 켠다
exit $LASTEXITCODE
