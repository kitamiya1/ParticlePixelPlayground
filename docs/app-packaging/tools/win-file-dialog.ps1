# Windows の「名前を付けて保存」「開く」ダイアログ（アプリ版が出す OS の標準ダイアログ）を UI Automation で操作する。
# 使い方：powershell -NoProfile -File win-file-dialog.ps1 -Path <フルパス> [-ProcessName app] [-TimeoutSec 20]
# ダイアログのファイル名の欄へ Path を入れて、既定のボタン（保存 / 開く）を押す。
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$ProcessName = 'app',
  [int]$TimeoutSec = 20
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$pids = @(Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -ExpandProperty Id)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$dlg = $null
while (-not $dlg -and (Get-Date) -lt $deadline) {
  # ダイアログは UI Automation の木ではアプリの窓（Tauri Window）の子として出る
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770')
  foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($pids -notcontains $w.Current.ProcessId) { continue }
    if ($w.Current.ClassName -eq '#32770') { $dlg = $w; break }
    $d = $w.FindFirst($TS::Children, $cond)
    if ($d) { $dlg = $d; break }
  }
  if (-not $dlg) { Start-Sleep -Milliseconds 300 }
}
if (-not $dlg) { Write-Output '{"ok":false,"why":"dialog not found"}'; exit 2 }
$title = $dlg.Current.Name
# ファイル名の欄：保存 = Edit 1001、開く = ComboBox 1148 の中の Edit
$edit = $null
foreach ($id in '1001', '1148') {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
  $e = $dlg.FindFirst($TS::Descendants, $c)
  if ($e) {
    if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) {
      $e = $e.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
    }
    if ($e) { $edit = $e; break }
  }
}
$how = 'uia'
if ($edit) {
  $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Path)
  Start-Sleep -Milliseconds 300
  $btn = $dlg.FindFirst($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, '1')))
  $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
  # ファイル名の欄が UI Automation に出ない版の Windows（ファイル名(N) の欄）：ダイアログを前へ出し、Alt+N → パス → Enter
  $how = 'keys'
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
  [W.U]::SetForegroundWindow([IntPtr]$dlg.Current.NativeWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait('%n')
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  # SendKeys の特殊文字（+^%~(){}[]）を括る
  $esc = ($Path -replace '([+^%~(){}\[\]])', '{$1}')
  [System.Windows.Forms.SendKeys]::SendWait($esc)
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Start-Sleep -Milliseconds 1000
Write-Output (@{ ok = $true; how = $how; title = $title; path = $Path } | ConvertTo-Json -Compress)
