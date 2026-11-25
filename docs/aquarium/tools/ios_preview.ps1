# iPhone 実機で PR のビルドを試すためのプレビュー（公開中の GitHub Pages とは別）。
# - 指定したブランチ / コミットを一時フォルダの git worktree に取り出してビルドし（作業中のフォルダ・dist は触らない）、
#   vite preview（この PC の localhost）で配り、Cloudflare の Quick Tunnel（アカウント不要）で https の一時 URL を作る。
# - URL は https://<ランダム>.trycloudflare.com。公開中のゲーム（https://kitamiya1.github.io/ParticlePixelPlayground/）とは
#   オリジンが違うので、IndexedDB / localStorage のセーブデータは共有しない（公開中のゲームの進捗には触れない）。
# - GitHub Pages・そのワークフロー・main には何もしない。この PC と、このスクリプトが動いている間だけ見られる
#   （Ctrl+C か、ウィンドウを閉じる / PC がスリープすると終わる。次に起動すると URL は変わる）。
# 使い方：powershell -NoProfile -File docs/aquarium/tools/ios_preview.ps1 [-Ref fix/aquarium-ios-zoom-help] [-Port 4190]
param(
  [string]$Ref = 'origin/fix/aquarium-ios-zoom-help',
  [int]$Port = 4190
)
# git・cloudflared は案内を stderr に出す（Windows PowerShell 5.1 は Stop だとそれを失敗として止まる）。失敗は終了コードで見る
$ErrorActionPreference = 'Continue'
$repo = (git rev-parse --show-toplevel).Trim()
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { throw 'cloudflared が見つかりません（https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/）' }

git -C $repo fetch origin --quiet
$sha = "$(git -C $repo rev-parse --short $Ref)".Trim()
if ($LASTEXITCODE -or -not $sha) { throw "$Ref が見つかりません" }
$root = Join-Path $env:TEMP 'ppp-ios-preview'
$wt = Join-Path $root "wt-$sha"
$out = Join-Path $root "build-$sha"
New-Item -ItemType Directory -Force $root | Out-Null
if (-not (Test-Path $wt)) {
  git -C $repo worktree add --detach $wt $sha
  if ($LASTEXITCODE) { throw 'worktree を作れませんでした' }
  # 依存は同じものを使う（package-lock が変わった PR では npm ci を worktree の中で行う）
  New-Item -ItemType Junction -Path (Join-Path $wt 'node_modules') -Target (Join-Path $repo 'node_modules') | Out-Null
}
Push-Location $wt
try {
  npx tsc --noEmit
  if ($LASTEXITCODE) { throw 'tsc が失敗しました' }
  npx vite build --outDir $out --emptyOutDir
  if ($LASTEXITCODE) { throw 'ビルドが失敗しました' }
} finally { Pop-Location }

Write-Host "ビルド：$Ref ($sha) → $out"
$server = Start-Process -PassThru -WindowStyle Hidden -FilePath 'cmd.exe' -WorkingDirectory $wt -ArgumentList "/c npx vite preview --outDir `"$out`" --port $Port --strictPort"
try {
  # Host ヘッダーを localhost にして渡す（vite preview は知らないホスト名を断る）
  & $cloudflared tunnel --no-autoupdate --url "http://localhost:$Port" --http-host-header "localhost:$Port" 2>&1 | ForEach-Object {
    $line = "$_"
    if ($line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
      $u = $Matches[0]
      Write-Host ''
      Write-Host "プレビュー（$sha）：$u/aquarium.html"
      Write-Host "診断・保存しない：$u/aquarium.html?diag&nosave"
      Write-Host ''
    }
  }
} finally {
  if ($server -and -not $server.HasExited) { taskkill /PID $server.Id /T /F | Out-Null }
}
