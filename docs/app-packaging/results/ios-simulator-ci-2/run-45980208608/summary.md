# iOS シミュレーターの起動の試験のまとめ

修正後の起動 8 回のうち成功 0 回（うち初回起動 3 回中 0 回）。GPU を止める試験の起動・対照（ctrl = 描画の準備を飛ばす）は数えない

対照：ctrl1=False, ctrl2=False

| 回 | 成功 | 起動完了（秒） | 描画の準備 | 最後のフレーム記録 | 画面（撮った秒：判定 / 下の帯の白） | 描画の喪失（ゲームの記録） | GPU の応答なし・終了（系統のログ） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cold1 | False | None | - | - | 5s:game/0.005 10s:game/0.005 15s:game/0.005 20s:game/0.005 30s:game/0.005 45s:game/0.005 60s:game/0.005 | 0 | 0 / 0 |
| cold1-restart | False | None | - | - | 10s:loading/0.005 20s:game/0.005 30s:game/0.005 | 0 | 0 / 0 |
| cold2 | False | None | - | - | 5s:loading/0.0 10s:loading/0.0 15s:loading/0.0 20s:loading/0.005 30s:game/0.005 45s:game/0.028 60s:game/0.005 | 0 | 0 / 0 |
| cold3 | False | None | - | - | 5s:loading/0.0 10s:loading/0.005 15s:game/0.005 20s:game/0.005 30s:game/0.005 45s:game/0.005 60s:game/0.005 | 0 | 0 / 0 |
| ctrl1 | False | None | - | - | 5s:loading/0.005 10s:game/0.005 15s:game/0.005 20s:game/0.005 30s:game/0.005 45s:game/0.005 60s:game/0.005 | 0 | 1 / 0 |
| ctrl2 | False | None | - | - | 5s:loading/0.0 10s:game/0.005 15s:game/0.005 20s:game/0.005 30s:game/0.005 45s:game/0.005 60s:game/0.005 | 0 | 0 / 0 |
| gpu | None | None | - | - | 5s:loading/0.0 | 0 | 0 / 3 |
| gpu-restart | False | None | - | - | 10s:game/0.005 20s:game/0.005 30s:game/0.005 | 0 | 0 / 0 |
| warm1 | False | None | - | - | 10s:game/0.005 20s:game/0.005 30s:game/0.005 | 0 | 0 / 0 |
| warm2 | False | None | - | - | 10s:game/0.005 20s:game/0.005 30s:game/0.005 | 0 | 0 / 0 |
| warm3 | False | None | - | - | 10s:loading/0.005 20s:game/0.005 30s:game/0.006 | 0 | 0 / 0 |

## GPU 処理を止めた後の画面

- gpu-after-kill-03s.png: {'kind': 'game', 'white': 0.004, 'dark': 0.171, 'bottomWhite': 0.005, 'size': '1206x2622'}
- gpu-after-kill-10s.png: {'kind': 'game', 'white': 0.004, 'dark': 0.174, 'bottomWhite': 0.005, 'size': '1206x2622'}
- gpu-after-kill-20s.png: {'kind': 'game', 'white': 0.004, 'dark': 0.175, 'bottomWhite': 0.005, 'size': '1206x2622'}
- gpu-after-kill-40s.png: {'kind': 'game', 'white': 0.004, 'dark': 0.176, 'bottomWhite': 0.005, 'size': '1206x2622'}
- gpu-before-kill.png: {'kind': 'game', 'white': 0.004, 'dark': 0.174, 'bottomWhite': 0.005, 'size': '1206x2622'}

## 記録の抜粋

### cold1

### cold1-restart
- syslog launchTook: 2026-11-27 10:26:34.515 F  Aquarium Explore[17024:d659] [com.apple.WebKit:Process] GPU process (0x113002420) took 1.383929 seconds to launch
- syslog launchTook: 2026-11-27 10:26:34.765 F  Aquarium Explore[17024:d659] [com.apple.WebKit:Process] Networking process (0x113007450) took 1.592239 seconds to launch

### cold2

### cold3
- syslog commitLate: 2026-11-27 10:51:45.788 Df Aquarium Explore[50483:24efd] [com.apple.WebKit:ViewState] 0x10685ba00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 9.31s after visible content rect update request; transac
- syslog commitLate: 2026-11-27 10:51:54.259 Df Aquarium Explore[50483:24efd] [com.apple.WebKit:ViewState] 0x10685ba00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 7.92s after visible content rect update request; transac

### ctrl1
- syslog launchTook: 2026-11-27 10:34:52.523 F  Aquarium Explore[33776:18204] [com.apple.WebKit:Process] WebContent process (0x110000e00) took 1.851321 seconds to launch
- syslog launchTook: 2026-11-27 10:34:53.807 F  Aquarium Explore[33776:18204] [com.apple.WebKit:Process] GPU process (0x110002420) took 2.986890 seconds to launch
- syslog launchTook: 2026-11-27 10:34:55.318 F  Aquarium Explore[33776:18204] [com.apple.WebKit:Process] Networking process (0x110007450) took 4.469130 seconds to launch
- syslog commitLate: 2026-11-27 10:34:57.016 Df Aquarium Explore[33776:18204] [com.apple.WebKit:ViewState] 0x101823e00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 6.18s after visible content rect update request; transac
- syslog unresponsive: 2026-11-27 10:34:55.528 E  Aquarium Explore[33776:18204] [com.apple.WebKit:Process] 0x102050218 - [pageProxyID=9, webPageID=10, PID=33796] WebPageProxy::processDidBecomeUnresponsive:

### ctrl2
- syslog launchTook: 2026-11-27 10:45:04.223 F  Aquarium Explore[44425:2015b] [com.apple.WebKit:Process] Networking process (0x111007450) took 1.083273 seconds to launch
- syslog commitLate: 2026-11-27 10:45:14.791 Df Aquarium Explore[44425:2015b] [com.apple.WebKit:ViewState] 0x10203e800 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 7.51s after visible content rect update request; transac

### gpu
- syslog launchTook: 2026-11-27 10:57:43.667 F  Aquarium Explore[58453:2a2df] [com.apple.WebKit:Process] GPU process (0x113002420) took 1.135221 seconds to launch
- syslog launchTook: 2026-11-27 10:57:43.882 F  Aquarium Explore[58453:2a2df] [com.apple.WebKit:Process] Networking process (0x113007450) took 1.325272 seconds to launch
- syslog gpuExited: 2026-11-27 10:59:05.174 E  Aquarium Explore[58453:2a2df] [com.apple.WebKit:Process] 0x113002420 - GPUProcessProxy::gpuProcessExited: reason=Crash
- syslog gpuExited: 2026-11-27 10:59:05.174 Df Aquarium Explore[58453:2a2df] [com.apple.WebKit:Process] 0x10502e808 - WebProcessPool::gpuProcessDidExit: PID=58503, reason=Crash
- syslog gpuExited: 2026-11-27 10:59:05.174 E  Aquarium Explore[58453:2a2df] [com.apple.WebKit:Process] 0x113000e00 - [PID=58495] WebProcessProxy::gpuProcessExited: reason=Crash

### gpu-restart

### warm1
- syslog launchTook: 2026-11-27 10:55:35.488 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] WebContent process (0x113000e00) took 1.114998 seconds to launch
- syslog launchTook: 2026-11-27 10:55:35.645 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] GPU process (0x113002420) took 1.204553 seconds to launch
- syslog launchTook: 2026-11-27 10:55:35.835 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] Networking process (0x113007450) took 1.377507 seconds to launch
- syslog commitLate: 2026-11-27 10:52:56.826 Df Aquarium Explore[52740:2647a] [com.apple.WebKit:ViewState] 0x101875a00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 7.18s after visible content rect update request; transac
- syslog commitLate: 2026-11-27 10:55:45.779 Df Aquarium Explore[55830:2873c] [com.apple.WebKit:ViewState] 0x10503ee00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 9.60s after visible content rect update request; transac

### warm2
- syslog launchTook: 2026-11-27 10:55:35.488 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] WebContent process (0x113000e00) took 1.114998 seconds to launch
- syslog launchTook: 2026-11-27 10:55:35.645 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] GPU process (0x113002420) took 1.204553 seconds to launch
- syslog launchTook: 2026-11-27 10:55:35.835 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] Networking process (0x113007450) took 1.377507 seconds to launch
- syslog commitLate: 2026-11-27 10:52:56.826 Df Aquarium Explore[52740:2647a] [com.apple.WebKit:ViewState] 0x101875a00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 7.18s after visible content rect update request; transac
- syslog commitLate: 2026-11-27 10:55:45.779 Df Aquarium Explore[55830:2873c] [com.apple.WebKit:ViewState] 0x10503ee00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 9.60s after visible content rect update request; transac

### warm3
- syslog launchTook: 2026-11-27 10:55:35.488 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] WebContent process (0x113000e00) took 1.114998 seconds to launch
- syslog launchTook: 2026-11-27 10:55:35.645 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] GPU process (0x113002420) took 1.204553 seconds to launch
- syslog launchTook: 2026-11-27 10:55:35.835 F  Aquarium Explore[55830:2873c] [com.apple.WebKit:Process] Networking process (0x113007450) took 1.377507 seconds to launch
- syslog commitLate: 2026-11-27 10:52:56.826 Df Aquarium Explore[52740:2647a] [com.apple.WebKit:ViewState] 0x101875a00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 7.18s after visible content rect update request; transac
- syslog commitLate: 2026-11-27 10:55:45.779 Df Aquarium Explore[55830:2873c] [com.apple.WebKit:ViewState] 0x10503ee00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 9.60s after visible content rect update request; transac
