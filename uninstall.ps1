# 卸载 dsh-cloud-sync（必须在 DSH 完全退出后运行）
param([string]$Profile = 'desktop')

$ErrorActionPreference = 'Stop'
$dsh = (Get-Command dsh -ErrorAction SilentlyContinue)?.Source
if (-not $dsh) { $dsh = 'C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' }

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek' }
if ($running) {
  Write-Host "❌ DSH 仍在运行（$($running.Count) 个进程），请先完全退出。" -ForegroundColor Red
  exit 1
}

& $dsh plugin --profile $Profile remove 'dsh-cloud-sync'
if ($LASTEXITCODE -ne 0) {
  Write-Host "⚠️ pnpm 卸载未成功，改用手工方式：" -ForegroundColor Yellow
  Write-Host "   编辑 $env:USERPROFILE\.dsh\profiles\$Profile\package.json"
  Write-Host "   删掉 dependencies 里的 dsh-cloud-sync 与 dsh.profile.bundles 里的同名项"
  exit 2
}
Write-Host "✅ 已卸载。插件自己的数据仍在 ~/.dsh/cloud-sync/（配置、备份目录），需要可手工删除。" -ForegroundColor Green
