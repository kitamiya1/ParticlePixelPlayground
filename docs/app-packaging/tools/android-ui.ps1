# Android（エミュレーター / 実機）の試験の補助。adb を使う。
#   -Forward <port> -Package <id>       … アプリの WebView の DevTools を localhost:<port> へつなぐ（debug ビルドだけ）
#   -Tap <正規表現>                      … 画面の要素（text / content-desc / resource-id）を uiautomator で探して押す
#   -SetText <文字列> [-Field <正規表現>]  … 入力欄（EditText）に文字を入れる（Field で絞る。無ければ最初の欄）
#   -Dump                                … 画面の要素の一覧（text・id・位置）
param(
  [int]$Forward = 0,
  [string]$Package = 'io.github.kitamiya1.aquariumexplore.debug',
  [string]$Tap = '',
  [string]$SetText = '',
  [string]$Field = '',
  [switch]$Dump,
  [int]$TimeoutSec = 15
)
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"

function Get-Nodes {
  & $adb shell uiautomator dump /sdcard/ui.xml | Out-Null
  $raw = (& $adb exec-out cat /sdcard/ui.xml) -join ''
  [xml]$x = $raw
  $x.SelectNodes('//node') | ForEach-Object {
    if ($_.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
      [pscustomobject]@{ text = $_.text; desc = $_.'content-desc'; id = $_.'resource-id'; cls = $_.class; clickable = $_.clickable
        x = ([int]$Matches[1] + [int]$Matches[3]) / 2; y = ([int]$Matches[2] + [int]$Matches[4]) / 2 }
    }
  }
}

if ($Forward -gt 0) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $procPid = ''
  while (-not $procPid -and (Get-Date) -lt $deadline) { $procPid = (& $adb shell pidof $Package).Trim(); if (-not $procPid) { Start-Sleep -Milliseconds 300 } }
  if (-not $procPid) { Write-Output '{"ok":false,"why":"process not found"}'; exit 2 }
  & $adb forward --remove "tcp:$Forward" 2>$null | Out-Null
  & $adb forward "tcp:$Forward" "localabstract:webview_devtools_remote_$procPid" | Out-Null
  Write-Output (@{ ok = $true; pid = $procPid; port = $Forward } | ConvertTo-Json -Compress)
  exit 0
}
if ($Dump) { Get-Nodes | Where-Object { $_.text -or $_.desc -or $_.id } | Format-Table text, desc, id, cls, x, y -AutoSize | Out-String -Width 220; exit 0 }
if ($SetText) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $e = Get-Nodes | Where-Object { $_.cls -eq 'android.widget.EditText' -and (-not $Field -or $_.text -match $Field -or $_.id -match $Field) } | Select-Object -First 1
    if ($e) {
      & $adb shell input tap $e.x $e.y
      Start-Sleep -Milliseconds 300
      & $adb shell input keyevent KEYCODE_MOVE_END
      for ($i = 0; $i -lt 80; $i++) { & $adb shell input keyevent KEYCODE_DEL }
      & $adb shell input text ($SetText -replace ' ', '%s')
      Write-Output (@{ ok = $true; set = $SetText } | ConvertTo-Json -Compress); exit 0
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Output '{"ok":false,"why":"EditText not found"}'; exit 3
}
if ($Tap) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $e = Get-Nodes | Where-Object { $_.text -match $Tap -or $_.desc -match $Tap -or $_.id -match $Tap } | Select-Object -First 1
    if ($e) {
      & $adb shell input tap $e.x $e.y
      Write-Output (@{ ok = $true; tapped = "$($e.text)|$($e.desc)|$($e.id)"; x = $e.x; y = $e.y } | ConvertTo-Json -Compress); exit 0
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Output "{`"ok`":false,`"why`":`"not found: $Tap`"}"; exit 4
}
