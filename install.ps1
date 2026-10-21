# 安装 dsh-cloud-sync 到指定 profile（必须在 DSH 完全退出后运行）
param(
  [string]$Profile = 'desktop',
  [string]$PluginDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
  $dsh = $dshCmd.Source
} else {
  $dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
}

if (-not (Test-Path $dsh)) { throw "找不到 dsh CLI：$dsh" }
if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) { throw "插件目录不对：$PluginDir" }

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek' }
if ($running) {
  Write-Host "❌ DSH 仍在运行（$($running.Count) 个进程）：$($running.ProcessName -join ', ')" -ForegroundColor Red
  Write-Host "   请先从托盘完全退出 DSH，再重新运行本脚本。"
  exit 1
}

$profileJson = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\package.json"
if (Test-Path $profileJson) {
  $bak = "$profileJson.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item $profileJson $bak
  Write-Host "已备份 profile manifest → $bak"
}

Write-Host "安装 $PluginDir → profile '$Profile' ..."
& $dsh plugin --profile $Profile add "link:$PluginDir"
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败，退出码 $LASTEXITCODE" }

$manifest = Get-Content $profileJson -Raw | ConvertFrom-Json
$bundles = $manifest.dsh.profile.bundles
Write-Host "`nprofile bundles:"
$bundles | ForEach-Object { Write-Host "  - $_" }
if ($bundles -notcontains 'dsh-cloud-sync') {
  Write-Host "`n⚠️ bundles 里没有 dsh-cloud-sync，插件不会被加载。" -ForegroundColor Yellow
  Write-Host "   手工把它加进 $profileJson 的 dsh.profile.bundles 后重启 DSH。" -ForegroundColor Yellow
  exit 2
}

Write-Host "`n✅ 安装完成。重启 DSH 后在任意会话执行：" -ForegroundColor Green
Write-Host "   /csync secret <WebDAV 应用密码>"
Write-Host "   /csync status"
