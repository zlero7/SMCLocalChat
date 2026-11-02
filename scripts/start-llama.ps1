# llama.cpp 서버 실행 (Windows). 여러 명이 동시에 쓸 수 있게 --parallel 로 칸을 나눈다 (기본 8칸).
# 사용법: powershell -ExecutionPolicy Bypass -File scripts\start-llama.ps1
#   값은 아래 기본값을 쓰거나 실행 전에 환경 변수로 바꾼다 (예: $env:LLAMA_PARALLEL = 2)
# .env 의 LLM_CONCURRENCY 는 LLAMA_PARALLEL 과, LLM_CONTEXT_TOKENS 는 LLAMA_CTX_PER_SLOT 과 같게 둔다.

[Console]::OutputEncoding = [Text.Encoding]::UTF8  # 한국어 안내가 깨지지 않게

function Get-Setting($name, $default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($v)) { return $default } else { return $v }
}

$exe        = Get-Setting 'LLAMA_SERVER'       'D:\llama.cpp\b11606\llama-server.exe'
$model      = Get-Setting 'LLAMA_MODEL'        'D:\llama.cpp\models\Qwen3.5-9B-Q4_K_M.gguf'  # unsloth/Qwen3.5-9B-GGUF (올라마 모델 파일은 형식이 달라 못 씀)
$alias      = Get-Setting 'LLAMA_ALIAS'        'qwen3.5:9b'   # .env 의 LLM_MODEL 과 같게
$port       = Get-Setting 'LLAMA_PORT'         '8081'
$parallel   = [int](Get-Setting 'LLAMA_PARALLEL'     '8')    # 동시에 답을 만드는 수 (Qwen 3.5 는 칸당 약 0.56GB 라 8칸 × 16384 도 16GB 에 들어감)
$ctxPerSlot = [int](Get-Setting 'LLAMA_CTX_PER_SLOT' '16384') # 한 사람당 대화 길이(토큰)
# 그림 읽기 파일 (같은 곳 unsloth/Qwen3.5-9B-GGUF 의 mmproj-F16.gguf). 없으면 그림 없이 글만
# 다른 대화의 앞부분을 램에 모아 두는 캐시. 이 빌드(b11606)는 캐시가 꽉 차서 오래된 것을 지울 때 가끔 GGML_ASSERT 로 서버가 죽어서(2026-10-28) 끈다 (0 = 끔, MiB).
# 칸마다 자기 대화를 이어 쓰는 속도 이점(LCP 재사용)은 그대로이고, 다른 칸에서 온 대화의 앞부분만 다시 계산한다
$cacheRam   = Get-Setting 'LLAMA_CACHE_RAM' '0'
$mmproj     = Get-Setting 'LLAMA_MMPROJ'       'D:\llama.cpp\models\Qwen3.5-9B-mmproj-F16.gguf'

# 다른 프로그램이 그래픽카드를 하나로 제한해 두었으면 풀어서 두 장 다 쓰게 한다
Remove-Item env:CUDA_VISIBLE_DEVICES -ErrorAction SilentlyContinue

$serverArgs = @(
  '-m', $model, '-a', $alias,
  '--host', '127.0.0.1', '--port', $port,
  '-c', ($parallel * $ctxPerSlot), '-np', $parallel,
  '-ngl', '99', '--flash-attn', 'auto',
  # 도구 호출과 생각 모드는 모델에 들어 있는 채팅 템플릿(jinja)으로 처리한다
  '--jinja', '--reasoning-format', 'deepseek',
  # Qwen 3.5 권장 샘플링 (Ollama 가 쓰던 값과 같음)
  '--temp', '1.0', '--top-k', '20', '--top-p', '0.95', '--presence-penalty', '1.5',
  '--cache-ram', $cacheRam,
  '--no-webui'
)
if (Test-Path $mmproj) { $serverArgs += @('--mmproj', $mmproj) } else { Write-Host "그림 읽기 파일이 없어서 그림 없이 시작: $mmproj" }

Write-Host "llama-server 시작: $alias, 동시 $parallel 명, 한 사람당 $ctxPerSlot 토큰, http://127.0.0.1:$port"
& $exe @serverArgs
# 프로그램이 비정상으로 끝났으면 그 종료 코드를 그대로 돌려줘야 작업 스케줄러가 1분 뒤 다시 켠다
exit $LASTEXITCODE
