# 安装后自检：确认插件真的进了 desktop profile（DSH 可开着，只读检查）
param([string]$Profile = 'desktop')

$ErrorActionPreference = 'Continue'
$profileJson = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\package.json"
$linked = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\dsh-cloud-sync"
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
  $dsh = $dshCmd.Source
} else {
  $dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
}

Write-Host "== 1. profile manifest ==" -ForegroundColor Cyan
if (-not (Test-Path $profileJson)) { Write-Host "  ❌ 找不到 $profileJson"; exit 1 }
$manifest = Get-Content $profileJson -Raw | ConvertFrom-Json
$hasDep = $null -ne $manifest.dependencies.'dsh-cloud-sync'
$hasBundle = @($manifest.dsh.profile.bundles) -contains 'dsh-cloud-sync'
Write-Host "  dependencies 有该包 : $hasDep"
Write-Host "  bundles 里有该层    : $hasBundle"
Write-Host "  当前 bundles: $(@($manifest.dsh.profile.bundles) -join ', ')"

Write-Host "`n== 2. 链接与入口 ==" -ForegroundColor Cyan
Write-Host "  node_modules 存在 : $(Test-Path $linked)"
if (Test-Path $linked) {
  foreach ($rel in @('package.json', 'lib\index.js', 'lib\client.js', 'cordis.patch.yml', 'icon.svg', 'locale\zh.json')) {
    Write-Host ("  {0,-22}: {1}" -f $rel, (Test-Path (Join-Path $linked $rel)))
  }
}

Write-Host "`n== 3. pnpm 依赖树 ==" -ForegroundColor Cyan
& $dsh plugin --profile $Profile list --depth 0 2>&1 | Select-String -Pattern 'cloud-sync|dsh-profile'

Write-Host "`n== 4. 运行时自检（需要 DSH 正在运行）==" -ForegroundColor Cyan
Write-Host "  在任意会话执行 /csync status；或直接访问 http://127.0.0.1:<GUI 端口>/cloud-sync/api/state"
Write-Host '  期望看到：{"ok":true,"data":{...}} —— 拿不到说明插件没挂上'

if (-not ($hasDep -and $hasBundle)) { Write-Host "`n❌ 安装不完整，请重跑 install.ps1" -ForegroundColor Red; exit 2 }
Write-Host "`n✅ 静态检查全部通过" -ForegroundColor Green
