# iOS シミュレーターの起動の試験のまとめ

修正後の起動 8 回のうち成功 8 回（うち初回起動 3 回中 3 回）。GPU を止める試験の起動・対照（ctrl = 描画の準備を飛ばす）は数えない

対照：ctrl1=True, ctrl2=True

| 回 | 成功 | 起動完了（秒） | 描画の準備 | 最後のフレーム記録 | 画面（撮った秒：判定 / 下の帯の白） | 描画の喪失（ゲームの記録） | GPU の応答なし・終了（系統のログ） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cold1 | True | 20.38 | done programs=26 ms=10385 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:5111 | frame 915 fps=27 gpu=ready holes=0 sand=0.00 buddy=hidden po | 10s:game/0.0 30s:game/0.0 60s:game/0.0 final:game/0.0 | 0 | 1 / 0 |
| cold1-restart | True | 10.1 | done programs=26 ms=679 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:86 sur | frame 795 fps=32 gpu=ready holes=0 sand=0.00 buddy=hidden po | 10s:loading/0.0 30s:game/0.0 final:game/0.0 | 0 | 0 / 0 |
| cold2 | True | 15.03 | done programs=26 ms=5611 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:2040  | frame 1083 fps=27 gpu=ready holes=0 sand=0.00 buddy=hidden p | 10s:game/0.0 30s:game/0.0 60s:game/0.0 final:game/0.0 | 0 | 0 / 0 |
| cold3 | True | 17.08 | done programs=26 ms=6059 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:2403  | frame 1045 fps=27 gpu=ready holes=0 sand=0.00 buddy=hidden p | 10s:loading/0.0 30s:game/0.0 60s:game/0.0 final:game/0.0 | 0 | 0 / 0 |
| ctrl1 | True | 10.65 | done programs=0 ms=0 slowest= | frame 1644 fps=31 gpu=ready holes=0 sand=0.00 buddy=hidden p | 10s:game/0.0 30s:game/0.0 60s:game/0.0 final:game/0.0 | 0 | 0 / 0 |
| ctrl2 | True | 13.01 | done programs=0 ms=0 slowest= | frame 3982 fps=26 gpu=ready holes=0 sand=0.00 buddy=hidden p | 10s:loading/0.0 30s:game/0.0 60s:game/0.0 final:game/0.0 | 0 | 0 / 0 |
| gpu | None | 9.65 | done programs=26 ms=768 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT | frame 1481 fps=24 gpu=ready holes=6 sand=2.89 buddy=hidden p | 5s:loading/0.0 final:game/0.0 | 1 | 3 / 6 |
| gpu-restart | True | 11.81 | done programs=26 ms=781 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT | frame 661 fps=23 gpu=ready holes=6 sand=2.89 buddy=hidden po | 10s:game/0.0 30s:game/0.0 final:game/0.0 | 0 | 0 / 0 |
| warm1 | True | 10.12 | done programs=26 ms=754 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:75 mes | frame 1126 fps=25 gpu=ready holes=0 sand=0.00 buddy=hidden p | 10s:game/0.0 20s:game/0.001 final:game/0.0 | 0 | 0 / 0 |
| warm2 | True | 9.5 | done programs=26 ms=601 slowest=mesh:Mesh[PPP_WATER,USE_LIFT,BUDDY]:61 mesh:Mesh[PPP_WATER | frame 482 fps=16 gpu=ready holes=0 sand=0.00 buddy=hidden po | 10s:game/0.0 20s:game/0.0 final:game/0.0 | 0 | 0 / 0 |
| warm3 | True | 9.48 | done programs=26 ms=532 slowest=surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:59 mesh:Mes | frame 918 fps=25 gpu=ready holes=0 sand=0.00 buddy=hidden po | 10s:game/0.0 20s:game/0.0 final:game/0.0 | 0 | 0 / 0 |

## GPU 処理を止めた後の画面

- gpu-after-kill-03s.png: {'kind': 'game', 'white': 0.001, 'dark': 0.047, 'bottomWhite': 0.0, 'size': '110x240'}
- gpu-after-kill-10s.png: {'kind': 'game', 'white': 0.0, 'dark': 0.049, 'bottomWhite': 0.0, 'size': '110x240'}
- gpu-after-kill-20s.png: {'kind': 'game', 'white': 0.0, 'dark': 0.047, 'bottomWhite': 0.0, 'size': '110x240'}
- gpu-after-kill-40s.png: {'kind': 'game', 'white': 0.0, 'dark': 0.049, 'bottomWhite': 0.0, 'size': '110x240'}
- gpu-before-kill.png: {'kind': 'game', 'white': 0.0, 'dark': 0.049, 'bottomWhite': 0.0, 'size': '110x240'}

## 記録の抜粋

### cold1
- [native] start 1795779152185 selftest=Some("")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:32:50.254Z +8.51s] build meshes+plants done 7562ms
- [aqua 11:32:51.303Z +9.56s] renderer created 8607ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:32:51.668Z +9.92s] save loaded store=indexeddb status=empty prims=0 sand=0.00 flush=0ms at 8976ms
- [aqua 11:33:02.122Z +20.38s] gpu: prepare (boot) done programs=26 ms=10385 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:5111 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT]:1010 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,USE_BONES]:480 surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:444 mesh:Mesh[PPP_WATER,USE_LIFT,FISH]:315
- [aqua 11:33:02.313Z +20.57s] frame 1 took 173ms programs=26
- [aqua 11:33:02.138Z +20.39s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:33:02.123Z +20.38s] boot done 19431ms gpu=ready
- [native] start 1795779152185 selftest=Some("")
- syslog launchTook: 2026-11-27 11:32:33.399 F  Aquarium Explore[23424:10497] [com.apple.WebKit:Process] WebContent process (0x111000e00) took 1.569601 seconds to launch
- syslog launchTook: 2026-11-27 11:32:35.060 F  Aquarium Explore[23424:10497] [com.apple.WebKit:Process] GPU process (0x111002320) took 3.026230 seconds to launch
- syslog launchTook: 2026-11-27 11:32:36.512 F  Aquarium Explore[23424:10497] [com.apple.WebKit:Process] Networking process (0x111007360) took 4.439752 seconds to launch
- syslog commitLate: 2026-11-27 11:32:38.829 Df Aquarium Explore[23424:10497] [com.apple.WebKit:ViewState] 0x102835e00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 6.78s after visible content rect update request; transac
- syslog unresponsive: 2026-11-27 11:32:36.419 E  Aquarium Explore[23424:10497] [com.apple.WebKit:Process] 0x10203ea18 - [pageProxyID=9, webPageID=10, PID=23436] WebPageProxy::processDidBecomeUnresponsive:

### cold1-restart
- [native] start 1795779232440 selftest=Some("")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:34:02.118Z +8.12s] build meshes+plants done 7580ms
- [aqua 11:34:03.152Z +9.16s] renderer created 8614ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:34:03.348Z +9.35s] save loaded store=indexeddb status=ok prims=0 sand=0.00 flush=0ms at 8810ms
- [aqua 11:34:04.096Z +10.10s] gpu: prepare (boot) done programs=26 ms=679 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:86 surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:65 mesh:Mesh[PPP_WATER,USE_LIFT,BUDDY]:48 mesh:Mesh[PPP_WATER,USE_LIFT]:47 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT]:41
- [aqua 11:34:04.260Z +10.26s] frame 1 took 157ms programs=26
- [aqua 11:34:04.101Z +10.11s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:34:04.096Z +10.10s] boot done 9558ms gpu=ready
- [native] start 1795779232440 selftest=Some("")
- syslog launchTook: 2026-11-27 11:33:53.344 F  Aquarium Explore[25456:11a07] [com.apple.WebKit:Process] GPU process (0x114002320) took 1.037599 seconds to launch
- syslog launchTook: 2026-11-27 11:33:53.576 F  Aquarium Explore[25456:11a07] [com.apple.WebKit:Process] Networking process (0x114007260) took 1.248647 seconds to launch
- syslog commitLate: 2026-11-27 11:34:03.503 Df Aquarium Explore[25456:11a07] [com.apple.WebKit:ViewState] 0x105049000 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 8.85s after visible content rect update request; transac

### cold2
- [native] start 1795779771705 selftest=Some("")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:43:02.251Z +7.69s] build meshes+plants done 7018ms
- [aqua 11:43:03.555Z +9.00s] renderer created 8321ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:43:03.894Z +9.34s] save loaded store=indexeddb status=empty prims=0 sand=0.00 flush=0ms at 8661ms
- [aqua 11:43:09.587Z +15.03s] gpu: prepare (boot) done programs=26 ms=5611 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:2040 surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:336 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,USE_BONES]:330 mesh:Mesh[PPP_WATER,USE_LIFT,FISH]:240 fx:Points[PPP_WATER]:209
- [aqua 11:43:09.824Z +15.27s] frame 1 took 198ms programs=26
- [aqua 11:43:09.625Z +15.07s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:43:09.589Z +15.03s] boot done 14356ms gpu=ready
- [native] start 1795779771705 selftest=Some("")
- syslog launchTook: 2026-11-27 11:42:52.772 F  Aquarium Explore[35237:18d32] [com.apple.WebKit:Process] GPU process (0x115002320) took 1.218056 seconds to launch
- syslog launchTook: 2026-11-27 11:42:52.948 F  Aquarium Explore[35237:18d32] [com.apple.WebKit:Process] Networking process (0x115007360) took 1.353873 seconds to launch

### cold3
- [native] start 1795780482584 selftest=Some("")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:54:55.422Z +9.49s] build meshes+plants done 8714ms
- [aqua 11:54:56.433Z +10.50s] renderer created 9724ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:54:56.880Z +10.95s] save loaded store=indexeddb status=empty prims=0 sand=0.00 flush=0ms at 10172ms
- [aqua 11:55:03.009Z +17.08s] gpu: prepare (boot) done programs=26 ms=6059 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:2403 surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:467 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT]:315 post:Mesh:241 mesh:Mesh[PPP_WATER,USE_LIFT]:238
- [aqua 11:55:03.189Z +17.26s] frame 1 took 163ms programs=26
- [aqua 11:55:03.025Z +17.09s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:55:03.011Z +17.08s] boot done 16303ms gpu=ready
- [native] start 1795780482584 selftest=Some("")
- syslog launchTook: 2026-11-27 11:54:43.550 F  Aquarium Explore[47448:2200e] [com.apple.WebKit:Process] Networking process (0x112007260) took 1.121273 seconds to launch
- syslog commitLate: 2026-11-27 11:54:57.506 Df Aquarium Explore[47448:2200e] [com.apple.WebKit:ViewState] 0x104046800 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 10.57s after visible content rect update request; transa

### ctrl1
- [native] start 1795779493454 selftest=Some("noprepare")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:38:25.515Z +8.93s] build meshes+plants done 7999ms
- [aqua 11:38:26.486Z +9.90s] renderer created 8969ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:38:27.165Z +10.58s] save loaded store=indexeddb status=empty prims=0 sand=0.00 flush=0ms at 9649ms
- [aqua 11:38:27.242Z +10.65s] gpu: prepare (boot) done programs=0 ms=0 slowest=
- [aqua 11:38:34.259Z +17.67s] frame 1 took 6450ms programs=25
- [aqua 11:38:27.806Z +11.22s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:38:27.243Z +10.65s] boot done 9727ms gpu=ready
- [native] start 1795779493454 selftest=Some("noprepare")
- [aqua 11:38:27.242Z +10.65s] selftest noprepare
- syslog launchTook: 2026-11-27 11:38:14.442 F  Aquarium Explore[29914:14e14] [com.apple.WebKit:Process] GPU process (0x110002320) took 1.186595 seconds to launch
- syslog launchTook: 2026-11-27 11:38:14.646 F  Aquarium Explore[29914:14e14] [com.apple.WebKit:Process] Networking process (0x110007360) took 1.342801 seconds to launch

### ctrl2
- [native] start 1795780070443 selftest=Some("noprepare")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:48:01.187Z +8.04s] build meshes+plants done 7042ms
- [aqua 11:48:05.595Z +12.45s] renderer created 11448ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:48:06.061Z +12.92s] save loaded store=indexeddb status=empty prims=0 sand=0.00 flush=0ms at 11917ms
- [aqua 11:48:06.150Z +13.01s] gpu: prepare (boot) done programs=0 ms=0 slowest=
- [aqua 11:48:12.745Z +19.60s] frame 1 took 6149ms programs=25
- [aqua 11:48:06.595Z +13.45s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:48:06.150Z +13.01s] boot done 12006ms gpu=ready
- [native] start 1795780070443 selftest=Some("noprepare")
- [aqua 11:48:06.150Z +13.01s] selftest noprepare
- syslog launchTook: 2026-11-27 11:47:51.513 F  Aquarium Explore[39833:1c8dd] [com.apple.WebKit:Process] Networking process (0x111007360) took 1.160354 seconds to launch

### gpu
- [native] start 1795780775706 selftest=Some("gpu")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:59:44.488Z +7.69s] build meshes+plants done 7493ms
- [aqua 11:59:45.465Z +8.67s] renderer created 8471ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:59:45.635Z +8.84s] save loaded store=indexeddb status=ok prims=0 sand=0.00 flush=0ms at 8641ms
- [aqua 11:59:46.454Z +9.65s] gpu: prepare (boot) done programs=26 ms=768 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT]:213 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:68 mesh:Mesh[PPP_WATER,USE_LIFT,FISH]:47 surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:46 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,USE_BONES]:36
- [aqua 11:59:46.607Z +9.81s] frame 1 took 140ms programs=26
- [aqua 11:59:46.467Z +9.67s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:59:46.454Z +9.65s] boot done 9460ms gpu=ready
- [aqua 12:00:11.510Z +34.71s] gpu: webglcontextlost #1 (state was ready, 1 in 120s)
- [aqua 12:00:11.953Z +35.15s] gpu: webglcontextrestored #1 (state was lost)
- [aqua 12:00:12.150Z +35.35s] gpu: save flush (lost) ok
- [native] start 1795780775706 selftest=Some("gpu")
- [aqua 11:59:45.682Z +8.88s] selftest gpu
- [aqua 11:59:54.476Z +17.68s] selftest dug
- syslog commitLate: 2026-11-27 11:59:45.761 Df Aquarium Explore[56790:27aea] [com.apple.WebKit:ViewState] 0x10205e800 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 8.76s after visible content rect update request; transac
- syslog unresponsive: 2026-11-27 12:00:11.504 E  Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x110000e00 - [PID=56800] WebProcessProxy::gpuProcessConnectionDidBecomeUnresponsive
- syslog unresponsive: 2026-11-27 12:00:11.504 E  Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x110002320 - GPUProcessProxy::childConnectionDidBecomeUnresponsive:
- syslog unresponsive: 2026-11-27 12:00:11.504 E  Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x110002320 - GPUProcessProxy::didBecomeUnresponsive: GPUProcess with PID 58024 became unresponsive, terminating it
- syslog gpuExited: 2026-11-27 12:00:06.002 E  Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x110002320 - GPUProcessProxy::gpuProcessExited: reason=Crash
- syslog gpuExited: 2026-11-27 12:00:06.002 Df Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x10102ec08 - WebProcessPool::gpuProcessDidExit: PID=56801, reason=Crash
- syslog gpuExited: 2026-11-27 12:00:06.002 E  Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x110000e00 - [PID=56800] WebProcessProxy::gpuProcessExited: reason=Crash
- syslog gpuExited: 2026-11-27 12:00:11.505 E  Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x110002320 - GPUProcessProxy::gpuProcessExited: reason=Unresponsive
- syslog gpuExited: 2026-11-27 12:00:11.505 Df Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x10102ec08 - WebProcessPool::gpuProcessDidExit: PID=0, reason=Unresponsive
- syslog gpuExited: 2026-11-27 12:00:11.505 E  Aquarium Explore[56790:27aea] [com.apple.WebKit:Process] 0x110000e00 - [PID=56800] WebProcessProxy::gpuProcessExited: reason=Unresponsive

### gpu-restart
- [native] start 1795780872340 selftest=Some("")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 12:01:22.983Z +9.38s] build meshes+plants done 9102ms
- [aqua 12:01:24.260Z +10.66s] renderer created 10378ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 12:01:24.593Z +10.99s] save loaded store=indexeddb status=ok prims=6 sand=2.89 flush=165ms at 10712ms
- [aqua 12:01:25.407Z +11.81s] gpu: prepare (boot) done programs=26 ms=781 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT]:103 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:75 surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:57 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,USE_BONES]:56 mesh:Mesh[PPP_WATER,USE_LIFT,FISH]:47
- [aqua 12:01:25.687Z +12.09s] frame 1 took 266ms programs=27
- [aqua 12:01:25.420Z +11.82s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 12:01:25.409Z +11.81s] boot done 11528ms gpu=ready
- [native] start 1795780872340 selftest=Some("")
- syslog launchTook: 2026-11-27 12:01:13.415 F  Aquarium Explore[60590:29e5f] [com.apple.WebKit:Process] Networking process (0x113007260) took 1.172097 seconds to launch

### warm1
- [native] start 1795780589886 selftest=Some("")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:56:38.897Z +7.80s] build meshes+plants done 7590ms
- [aqua 11:56:40.237Z +9.14s] renderer created 8930ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:56:40.407Z +9.31s] save loaded store=indexeddb status=ok prims=0 sand=0.00 flush=0ms at 9100ms
- [aqua 11:56:41.212Z +10.12s] gpu: prepare (boot) done programs=26 ms=754 slowest=mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:75 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,USE_BONES]:72 surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:53 mesh:Mesh[PPP_WATER,USE_LIFT]:43 mesh:Mesh[PPP_WATER,USE_LIFT,FISH]:36
- [aqua 11:56:41.385Z +10.29s] frame 1 took 157ms programs=26
- [aqua 11:56:41.226Z +10.13s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:56:41.214Z +10.12s] boot done 9907ms gpu=ready
- [native] start 1795780589886 selftest=Some("")
- syslog launchTook: 2026-11-27 11:56:30.918 F  Aquarium Explore[50968:24151] [com.apple.WebKit:Process] Networking process (0x111007260) took 1.109058 seconds to launch
- syslog commitLate: 2026-11-27 11:56:40.585 Df Aquarium Explore[50968:24151] [com.apple.WebKit:ViewState] 0x10183ca00 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 9.24s after visible content rect update request; transac

### warm2
- [native] start 1795780681086 selftest=Some("")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:58:10.108Z +7.86s] build meshes+plants done 7167ms
- [aqua 11:58:10.936Z +8.68s] renderer created 7994ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:58:11.101Z +8.85s] save loaded store=indexeddb status=ok prims=0 sand=0.00 flush=0ms at 8160ms
- [aqua 11:58:11.751Z +9.50s] gpu: prepare (boot) done programs=26 ms=601 slowest=mesh:Mesh[PPP_WATER,USE_LIFT,BUDDY]:61 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:53 mesh:Mesh[PPP_WATER,USE_LIFT]:48 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT]:40 surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:40
- [aqua 11:58:11.888Z +9.63s] frame 1 took 120ms programs=26
- [aqua 11:58:11.767Z +9.51s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:58:11.752Z +9.50s] boot done 8811ms gpu=ready
- [native] start 1795780681086 selftest=Some("")

### warm3
- [native] start 1795780718900 selftest=Some("")
- [native] ios: scrollView.contentInsetAdjustmentBehavior = never
- [aqua 11:58:48.044Z +8.03s] build meshes+plants done 7798ms
- [aqua 11:58:48.828Z +8.82s] renderer created 8582ms gl=Apple GPU parallelCompile=true tris=568070
- [aqua 11:58:48.931Z +8.92s] save loaded store=indexeddb status=ok prims=0 sand=0.00 flush=0ms at 8685ms
- [aqua 11:58:49.491Z +9.48s] gpu: prepare (boot) done programs=26 ms=532 slowest=surfel:Mesh[PPP_WATER,OCCLUDER_CUT,PLANT_BEND]:59 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,OCCLUDER_CUT]:40 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,CUTAWAY,OCCLUDER_CUT]:30 mesh:Mesh[PPP_WATER,USE_LIFT,BUDDY]:27 mesh:Mesh[PPP_WATER,USE_BEAMS,BLOB_UP,USE_BONES]:25
- [aqua 11:58:49.603Z +9.59s] frame 1 took 97ms programs=26
- [aqua 11:58:49.506Z +9.49s] layout inner=402x874 canvas=402x874@0 safe(t,r,b,l)=62,0,34,0 lowestControl=tb:833 limit=840
- [aqua 11:58:49.492Z +9.48s] boot done 9246ms gpu=ready
- [native] start 1795780718900 selftest=Some("")
- syslog commitLate: 2026-11-27 11:58:49.018 Df Aquarium Explore[54670:26647] [com.apple.WebKit:ViewState] 0x10501c800 (pageProxyID=9) -[WKWebView _didCommitLayerTree:] - finally received commit 8.83s after visible content rect update request; transac
