#!/usr/bin/env bash
# iOS シミュレーターでの起動の試験（GitHub Actions の macOS で .github/workflows/app-ios.yml から呼ぶ）。
#   ios-sim-run.sh <.app のパス> <bundle id> <出力のフォルダ> [初回起動の回数 = 3]
# 1. 初回起動 × N：シミュレーターを消去（erase）→ 起動 → インストール → アプリを起動して 60 秒（毎回まっさらの状態から）
#    1 回目の後だけ、アプリを終了してもう一度起動（終了後の再起動）。間に対照（描画の準備を飛ばす）の初回起動 × N−1
# 2. 続けて起動 × 3：同じシミュレーターでアプリを終了 → 起動（30 秒）
# 3. GPU 処理を外から止める：AQUA_SELFTEST=gpu で起動（4 秒後に掘って保存）→ 掘った後に com.apple.WebKit.GPU を kill -9
#    → 画面と記録（描画の喪失・復旧）→ アプリを終了して起動し直し、掘った穴が保存から戻るか
# 各回：ゲームの記録（標準エラー：AquaPlatform.diag）・画面（決めた秒）・系統のログ（WebKit・GPU）・プロセスのメモリ
set -u
APP=$1
BID=$2
OUT=$3
COLD=${4:-3}
mkdir -p "$OUT"
UDID=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next(x["udid"] for k,v in d.items() if "iOS" in k for x in v if x["name"].startswith("iPhone")))')
xcrun simctl list devices available | grep "$UDID" | tee "$OUT/device.txt"

note() { echo "[$(date -u '+%H:%M:%S')] $*" | tee -a "$OUT/timeline.txt"; }

mem() { # $1 = 名前：シミュレーターの中の WebKit とアプリのプロセスの RSS（KB）
  {
    echo "== $1 $(date -u '+%H:%M:%S')"
    ps -axo pid,rss,etime,command | grep -E 'simruntime.*(WebKit\.(GPU|WebContent|Networking))|Aquarium Explore.app' | grep -v grep | awk '{c=$4; for(i=5;i<=NF;i++) c=c" "$i; n=split(c,p,"/"); printf "%s rss=%dKB etime=%s %s\n", $1, $2, $3, p[n]}'
  } >> "$OUT/memory.txt"
}

# ゲームの記録のファイル（アプリの diag.log：src-tauri/src/lib.rs の diag_write。リリース版の標準エラーは届かなかったので）
diagfile() {
  local c
  c=$(xcrun simctl get_app_container "$UDID" "$BID" data 2>/dev/null) || return 0
  find "$c/Library" -name diag.log 2>/dev/null | head -1
}

# アプリを起動して、決めた秒に画面を撮る。$1 = 名前、$2 = 撮る秒（空白区切り）、$3 = AQUA_SELFTEST
# 撮り終えたら、ゲームの記録に 5 秒ごとの記録が 2 回出るまで（最大 150 秒）待ち、最後の画面（-final）を撮る。
# 記録はこの回の分だけ $name.diag.log へ移す（次の回は新しいファイルに書く）
run() {
  local name=$1 shots=$2 st=${3:-}
  local T0 t now f
  local start
  start=$(date '+%Y-%m-%d %H:%M:%S')
  f=$(diagfile)
  [ -n "$f" ] && rm -f "$f"
  note "launch $name (selftest=${st:-none})"
  SIMCTL_CHILD_AQUA_SELFTEST="$st" xcrun simctl launch --terminate-running-process --stdout="$OUT/$name.out" --stderr="$OUT/$name.err" "$UDID" "$BID" > "$OUT/$name.launch" 2>&1
  T0=$(date +%s)
  for t in $shots; do
    now=$(( $(date +%s) - T0 ))
    [ "$now" -lt "$t" ] && sleep $(( t - now ))
    xcrun simctl io "$UDID" screenshot "$OUT/$name-$(printf '%03d' "$t")s.png" > /dev/null 2>&1
    note "  $name shot ${t}s (actual $(( $(date +%s) - T0 ))s)"
    [ "$t" -eq 30 ] && mem "$name@30s"
  done
  for k in $(seq 1 150); do
    f=$(diagfile)
    [ -n "$f" ] && [ "$(grep -c '\] frame [0-9]* fps=' "$f" 2>/dev/null)" -ge 2 ] && break
    [ $(( $(date +%s) - T0 )) -ge 150 ] && break
    sleep 1
  done
  xcrun simctl io "$UDID" screenshot "$OUT/$name-final.png" > /dev/null 2>&1
  note "  $name final shot (actual $(( $(date +%s) - T0 ))s, diag=${f:-none})"
  echo "$start" > "$OUT/$name.start"
}

# この回の記録を移す（run の後、次の起動の前に呼ぶ）
takediag() {
  local f
  f=$(diagfile)
  if [ -n "$f" ]; then mv "$f" "$OUT/$1.diag.log"; else note "  $1: no diag.log"; fi
}

syslog() { # $1 = 名前、$2 = 開始時刻
  xcrun simctl spawn "$UDID" log show --start "$2" --style compact \
    --predicate 'process CONTAINS[c] "aquarium" OR process == "com.apple.WebKit.WebContent" OR process == "com.apple.WebKit.GPU"' \
    > "$OUT/$1-syslog.txt" 2>&1 || true
}

fresh() { # シミュレーターを消去して起動し、アプリを入れる（まっさらの初回起動）
  note "erase + boot + install ($1)"
  xcrun simctl shutdown "$UDID" > /dev/null 2>&1 || true
  xcrun simctl erase "$UDID"
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b > /dev/null
  xcrun simctl install "$UDID" "$APP"
}


# 初回起動：修正後（cold1…）と、対照（ctrl1…：AQUA_SELFTEST=noprepare = 描画の準備を飛ばして変更前と同じく最初のフレームで
# まとめてシェーダーを作る）を交互に。どちらも毎回シミュレーターを消去してから。
# 消去した直後は画面を撮るだけで数十秒かかる（第 3 段の 1 回目の CI）ので、撮る回数を絞り、時刻はゲームの記録で見る
for i in $(seq 1 "$COLD"); do
  fresh "cold$i"
  run "cold$i" "10 30 60"
  syslog "cold$i" "$(cat "$OUT/cold$i.start")"
  takediag "cold$i"
  if [ "$i" -eq 1 ]; then
    xcrun simctl terminate "$UDID" "$BID" || true
    run "cold1-restart" "10 30"
    syslog "cold1-restart" "$(cat "$OUT/cold1-restart.start")"
    takediag "cold1-restart"
  fi
  if [ "$i" -lt "$COLD" ]; then
    fresh "ctrl$i"
    run "ctrl$i" "10 30 60" noprepare
    syslog "ctrl$i" "$(cat "$OUT/ctrl$i.start")"
    takediag "ctrl$i"
  fi
done

# 続けて起動（アプリを終了 → 起動）
for i in 1 2 3; do
  xcrun simctl terminate "$UDID" "$BID" || true
  run "warm$i" "10 20"
  syslog "warm$i" "$(cat "$OUT/warm$i.start")"
  takediag "warm$i"
done

# GPU 処理を外から止める（掘ってから）
xcrun simctl terminate "$UDID" "$BID" || true
run "gpu" "5" gpu
for k in $(seq 1 90); do f=$(diagfile); [ -n "$f" ] && grep -q 'selftest dug' "$f" && break; sleep 1; done
sleep 3
xcrun simctl io "$UDID" screenshot "$OUT/gpu-before-kill.png" > /dev/null 2>&1
mem "gpu-before-kill"
GPUPIDS=$(pgrep -f 'simruntime.*com\.apple\.WebKit\.GPU' || true)
note "kill -9 WebKit.GPU pids: ${GPUPIDS:-none}"
[ -n "$GPUPIDS" ] && kill -9 $GPUPIDS
prev=0
for t in 3 10 20 40; do
  sleep $(( t - prev )); prev=$t
  xcrun simctl io "$UDID" screenshot "$OUT/gpu-after-kill-$(printf '%02d' "$t")s.png" > /dev/null 2>&1
  note "  gpu after kill ${t}s"
done
mem "gpu-after-kill"
syslog "gpu" "$(cat "$OUT/gpu.start")"
takediag "gpu"
# 終了して起動し直す：掘った穴が保存から戻るか（記録の save loaded の prims と、gpu の記録の holes を比べる）
xcrun simctl terminate "$UDID" "$BID" || true
run "gpu-restart" "10 30"
syslog "gpu-restart" "$(cat "$OUT/gpu-restart.start")"
takediag "gpu-restart"
xcrun simctl terminate "$UDID" "$BID" || true
note "done"