// personMask.js — 「人物を避けてコメントを描画」機能
//
// TF.js(WebGLバックエンド) + MediaPipe Selfie Segmentation(tfjs runtime / ローカル同梱モデル) で
// 配信映像から人物領域をリアルタイム推定する。
//
// 【描画方式】DRAW_MODE で3方式を切替可能(hybrid / overlay / commentMask)。
//   overlay: コメント層に触れず、映像から切り出した「人物だけ」をコメントの“上”に重ね描画。
//     → 人物がコメントの手前に出る＝人物の上のコメントが隠れる（公式スマホアプリ相当）。
//     コメント層を触らないのでチラつきが出ない。人物の切り出しは元映像と同ピクセルを同位置に描くので継ぎ目なし。
//   commentMask: コメント層(#comment-layer-container)に CSS mask を当て、人物の形にコメントを透過(比較用)。
//     overlayと違い「コメントに穴を開ける(穴の中は実映像)」だけなので、マスクがズレても人物が歪まない。
//     点滅軽減: SVG固定参照+canvas更新(CM_MASK_STRATEGY='svg' 既定) / ダブルバッファ / blob(旧・ロールバック用)。
//   hybrid: 静止時=overlay / 激しい動き=commentMask を動き量でヒステリシス切替(既定)。
//
// 【ギフト/ゲーム対策】人物切り出しから、ギフト/ゲーム層(#akashic-gameview)が描画されている領域を
//   destination-out で削り取る。→ ギフト/ゲーム/エモーションの上には人物を描かない＝ギフト等が人物に隠れない。
//
// 【推論のWorker化(カクつき対策)】重いGPU推論(segmentPeople)を Web Worker(personMaskWorker.js)へ逃がし、
//   メインスレッド(=ニコ生のコメント描画)を解放する。メインは createImageBitmap で軽くフレームを作り
//   Workerへ transfer し、返ったマスクで描画する。Worker生成/初期化に失敗した環境では、自動で
//   メインスレッド推論にフォールバックする(従来動作)。描画(drawCutout)は常にメインで毎フレーム。
//
// 制御は拡張メニューの「人物を避けてコメントを描画」トグル(main.js #radio-comment-avoid)から
// window.NicoPersonMask.start()/stop() で行う。
// 非破壊: コメント層直下に重ね描画用 <canvas> を1枚追加するだけ。OFF/停止で canvas を除去＝完全可逆。

(function () {
  const TAG = '[personMask]';

  // ===== 調整パラメータ =====
  const SEG_THROTTLE_MS = 90;   // セグメンテーション間隔の初期値/rAFフォールバック値(rVFC時は映像fpsに自動追従)
  const SEG_MIN_INTERVAL_MS = 16; // セグメンテーション間隔の下限(=最大約60fps)。Worker推論はworkerBusyで直列化され
                                  //   実頻度はWorkerの推論速度で頭打ちになるため、ここは「映像fpsまで許可」する役。小さいほど追従↑(残像↓)
  const DRAW_THROTTLE_MS = 33;  // 重ね描画の間隔(rAFフォールバック時のみ。通常はrVFCで動画フレーム同期描画)
  const DPR_CAP = 1.5;          // 重ね描画canvasの解像度上限(devicePixelRatioの上限)。上げると人物切り出しの縁がくっきり(負荷増)
  const WORK_LONG = 256;        // 推論入力の長辺px。16:9なら256×144となりlandscapeモデル入力にぴったり(リサイズ無し)
  // 使用モデル: landscape(144×256)はgeneral(256×256)より推論が軽く速い＝マスク更新が速く残像が減る。
  //   16:9映像では landscape(256/144=16:9)が歪まず精度面でも有利。general に戻すなら両値を general 系に。
  const MODEL_TYPE = 'landscape';
  const MODEL_DIR = 'models/selfie-segmentation-landscape';
  const FG_THRESHOLD = 0.6;     // 人物と判定する確信度。低いほどハッキリ(背景の誤検出は増える / 既定0.5)
  const MASK_DILATE = 2;        // 人物マスクの膨張px(work解像度基準)。大きいほど人物の外側まで余裕を持って隠す
  const MASK_BLUR = 2;          // 人物マスク境界のぼかしpx(静止時の基本値)
  const MASK_BLUR_MOTION = 6;   // 動き量が MOTION_HIGH 時に加算するぼかしpx。激しい動きの境界をごまかす
  const EMA_K = 0.62;           // 人物マスクの時間平滑化係数(0〜1)。大きいほど動きに速く追従(残像減)だが境界が少し揺れる
  const GIFT_DILATE = 8;        // ギフト/ゲーム削り取りの膨張px(CSS座標)。大きいほど高速移動ギフトの残像を抑える(負荷増)
  // 動き適応の収縮(erode): 激しい動きほど人物マスクを小さめ(収縮)にして残像を減らす。
  //   残像はマスクのズレで前位置に切れ端が残る現象。マスクを内側へ削れば前位置に残る量が減る。
  //   動き量(マスクの時間変化)を MOTION_LOW〜MOTION_HIGH で 0〜MOTION_ERODE_MAX px の収縮量へ線形マッピング。
  //   静止時=収縮0(膨張マスクそのまま)、激しい時=最大収縮。透過自体は常に維持(見栄え優先)。
  //   閾値は MOTION_DEBUG=true のconsoleログ(静止時/激しい時の値)を見て調整する。0-255スケール。
  const MOTION_ADAPT = true;    // 動き適応収縮の有効/無効
  const MOTION_LOW = 4;         // この動き量以下は収縮なし(実測: 静止時 level≈0.5〜2.9)
  const MOTION_HIGH = 18;       // この動き量で収縮が最大に(実測: 激しい時 level≈15.7〜22)
  const MOTION_ERODE_MAX = 6;   // 最大収縮px(work解像度基準)。大きいほど激しい動き時に人物マスクを小さく削る
  const MOTION_EMA_K = 0.3;     // 動き量の時間平滑化係数(急な変化のバタつきを防ぐ)
  const MOTION_DEBUG = false;   // true で動き量を約1秒ごとにconsole出力(閾値調整用)
  // マスク生成canvasの余白px(work解像度基準)。人物が画面端に達した時、端画素を余白へ複製してから
  // ぼかし/収縮するので、ぼかし・収縮の縁が余白(画面外)側で起き、表示画面の端は不透明のまま=額縁状ズレを防ぐ。
  // ぼかし(外側へ約2倍広がる)・収縮・膨張を吸収できる幅を確保。
  const MASK_PAD = Math.ceil((MASK_BLUR + MASK_BLUR_MOTION) * 2 + MOTION_ERODE_MAX + MASK_DILATE);
  // 描画モード: 'hybrid'(既定) | 'overlay'(常に重ね描画) | 'commentMask'(常にコメントマスク/比較用)
  //   実行中の切替は NicoPersonMask.setDrawMode('commentMask') 等でも可能。
  let drawMode = 'commentMask';
  const CM_MASK_LONG = 360;     // コメントマスク方式で生成するマスクの長辺px(コンテナ座標)
  // コメントマスク適用戦略: 'svg'(固定SVG参照+canvas更新/既定) | 'doubleBuffer' | 'blob'(旧方式)
  const CM_MASK_STRATEGY = 'doubleBuffer';
  const CM_MASK_UPDATE_MS = 200;  // マスク内容の更新最短間隔(ms)。CSS mask-image 自体は svg 方式では初回のみ
  const CM_REVOKE_DELAY_MS = 500; // blob/doubleBuffer 方式の objectURL 解放遅延
  const CM_MASK_SVG_ID = 'nicoPersonCommentMaskSvg';
  const CM_MASK_DEF_ID = 'nicoPersonCommentMaskDef';
  const WORKER_INIT_TIMEOUT_MS = 10000; // Worker初期化のタイムアウト(超過でメインスレッド推論へフォールバック)
  const DEBUG_OVERLAY = false;  // true で人物切り出しを赤半透明で表示(検証用)

  let segmenter = null;         // メインスレッド推論用(フォールバック時のみ生成)
  let running = false;
  let rafId = null;
  let rvfcId = 0, rvfcVideo = null; // requestVideoFrameCallback 用(動画フレーム同期描画)
  let lastInfer = 0;
  let lastDraw = 0;             // 重ね描画の間引き用(rAFフォールバック時のみ)
  let lastFrameTs = 0;          // 直近の動画フレーム提示時刻(映像fps推定用)
  let segIntervalMs = SEG_THROTTLE_MS; // セグメンテーション間隔。rVFC時は映像fps(フレーム間隔)に自動追従
  let inferBusy = false;        // メイン推論の多重実行防止
  let personReady = false;      // 最初の人物マスクが用意できたか
  let errCount = 0;             // 連続エラー数(WebGLコンテキスト喪失時に自動OFFするため)
  let motionLevel = 0;          // 平滑化した動き量(マスクの時間変化)
  let motionDbgT0 = 0;          // 動き量デバッグログのタイマ
  let erodeC = null, erctx = null; // マスク収縮用の作業canvas
  let tpC = null, tpctx = null;    // パディング付き(端複製)マスク用の作業canvas
  // コメントマスク方式用: true=CSSマスク適用中(=overlay描画を止める)
  let cmActive = false;
  let cmMaskC = null, cmctx = null; // マスク描画canvas(svg方式では SVG foreignObject 内 / 他方式では作業用)
  let cmMaskCssApplied = false;   // svg方式: mask-image を初回だけ設定済みか
  let cmLastUpdate = 0;           // マスク内容更新の間引き用
  let cmMaskSvg = null, cmMaskEl = null, cmMaskFo = null; // svg方式の DOM
  // doubleBuffer / blob 方式用
  let cmImgA = null, cmImgB = null, cmImgFlip = false;
  let cmPrevUrl = null;

  let worker = null;            // 推論Worker(使えれば)
  let useWorker = false;        // true:Worker推論 / false:メインスレッド推論
  let workerReady = false;
  let workerBusy = false;       // Worker推論の多重送信防止
  let frameSeq = 0;

  let work = null, wctx = null;          // メイン推論入力用の縮小canvas
  let tmp = null, ttx = null;            // マスクImageDataの描画先
  let personMaskC = null, pmctx = null;  // 人物マスク(人物=不透明/背景=透明、膨張・ぼかし済み)
  let emaBuf = null, emaW = 0, emaH = 0; // EMA用アルファバッファ
  let overlayC = null, ovctx = null;     // コメントの上に重ねる人物切り出しcanvas
  let waitOverlayEl = null;              // 準備中オーバーレイ(映像・コメント上)
  let toastEl = null, toastTm = null;    // 自前トースト(ニコ生スナックバーは再描画で消えるため使わない)
  let toastLayoutBound = false;

  function getVideo() {
    return document.querySelector('[class*="___video-layer___"] video');
  }
  function getCommentContainer() {
    return document.getElementById('comment-layer-container');
  }
  function getGiftCanvases() {
    const root = document.getElementById('akashic-gameview');
    return root ? root.querySelectorAll('canvas') : [];
  }
  function isHanten() {
    const b = document.getElementById('radio-hanten');
    return !!b && b.getAttribute('aria-pressed') === 'true';
  }
  function isValidDrawMode(mode) {
    return mode === 'hybrid' || mode === 'overlay' || mode === 'commentMask';
  }
  // 推論毎: drawMode に応じて overlay / コメントマスク の適用状態を更新
  function syncDrawModeAfterMask() {
    if (drawMode === 'commentMask') {
      if (!cmActive) cmActive = true;
      const container = getCommentContainer();
      if (container) buildAndApplyCommentMask(container);
      return;
    }
    if (drawMode === 'hybrid') {
      if (!cmActive && motionLevel >= MOTION_HIGH) cmActive = true;
      else if (cmActive && motionLevel <= MOTION_LOW) deactivateCommentMask();
      if (cmActive) {
        const container = getCommentContainer();
        if (container) buildAndApplyCommentMask(container);
      }
      return;
    }
    if (cmActive) deactivateCommentMask();
  }

  const WAIT_MSG = '人物マスクを生成しています';

  // 準備中オーバーレイの表示先(コメント層=映像表示域と同サイズで重なる)
  function getWaitOverlayHost() {
    return getCommentContainer()
      || document.querySelector('[class*="___video-layer___"]')
      || null;
  }

  // トーストの位置基準(映像表示域)。マスク対象のコメント層の子に置かないこと。
  function getToastAnchor() {
    return getCommentContainer()
      || document.querySelector('[class*="___video-layer___"]')
      || null;
  }

  function positionToast() {
    if (!toastEl) return;
    const anchor = getToastAnchor();
    var cx = null, cy = null;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
      }
    }
    if (cx == null) {
      cx = window.innerWidth / 2;
      cy = window.innerHeight / 2;
    }
    toastEl.style.left = cx + 'px';
    toastEl.style.top = cy + 'px';
  }

  // ネイティブ全画面は body 直下のうち data-browser-fullscreen=ignore 無し要素を非表示にする
  function bindToastLayoutListeners() {
    if (toastLayoutBound) return;
    toastLayoutBound = true;
    var reposition = function () {
      if (!toastEl || toastEl.style.opacity === '0') return;
      positionToast();
    };
    window.addEventListener('resize', reposition);
    document.addEventListener('fullscreenchange', reposition);
    var fsBtn = document.querySelector('[class*="___fullscreen-button___"]');
    if (fsBtn && typeof MutationObserver !== 'undefined') {
      new MutationObserver(reposition).observe(fsBtn, {
        attributes: true,
        attributeFilter: ['data-toggle-state']
      });
    }
  }

  function showWaitOverlay() {
    const host = getWaitOverlayHost();
    if (!host) return false;
    if (!waitOverlayEl) {
      waitOverlayEl = document.createElement('div');
      waitOverlayEl.id = 'nicoPersonMaskWait';
      waitOverlayEl.className = 'nico-person-mask-wait';
      waitOverlayEl.innerHTML =
        '<div class="nico-person-mask-wait__tint"></div>' +
        '<div class="nico-person-mask-wait__grid"></div>' +
        '<div class="nico-person-mask-wait__scan"></div>';
    }
    if (waitOverlayEl.parentElement !== host) host.appendChild(waitOverlayEl);
    requestAnimationFrame(function () {
      if (waitOverlayEl) waitOverlayEl.classList.add('is-visible');
    });
    notify(WAIT_MSG, 0);
    return true;
  }

  // complete=true で初回マスク完了時の ON トーストへ切替
  function hideWaitOverlay(complete) {
    if (waitOverlayEl) {
      waitOverlayEl.classList.remove('is-visible');
      const el = waitOverlayEl;
      setTimeout(function () {
        if (el && !el.classList.contains('is-visible')) el.remove();
      }, 380);
    }
    if (complete) {
      notify('人物を避けてコメントを描画：ON' + (useWorker ? '' : '（互換モード）'), 1500);
    } else if (toastEl && toastEl.textContent === WAIT_MSG) {
      toastEl.style.opacity = '0';
      if (toastTm) { clearTimeout(toastTm); toastTm = null; }
    }
  }

  // 映像の中央に短く表示する自前トースト。body固定配置でコメントマスク/人物切り出しの影響を受けない。
  function notify(msg, ms) {
    if (!toastEl || !document.body.contains(toastEl)) {
      toastEl = document.createElement('div');
      toastEl.id = 'nicoPersonMaskToast';
      toastEl.setAttribute('data-browser-fullscreen', 'ignore');
      toastEl.style.cssText =
        'position:fixed; transform:translate(-50%,-50%); z-index:2147483647;' +
        'background:rgba(37,37,37,.92); color:#fff; padding:8px 16px; border-radius:6px;' +
        'font-size:14px; font-family:sans-serif; box-shadow:0 0 8px rgba(0,0,0,.6);' +
        'pointer-events:none; white-space:nowrap; opacity:0; transition:opacity .2s ease;';
      bindToastLayoutListeners();
    }
    if (toastEl.parentElement !== document.body) document.body.appendChild(toastEl);
    if (!toastEl.getAttribute('data-browser-fullscreen')) {
      toastEl.setAttribute('data-browser-fullscreen', 'ignore');
    }
    positionToast();
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    if (toastTm) { clearTimeout(toastTm); toastTm = null; }
    if (ms && ms > 0) {
      toastTm = setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, ms);
    }
  }

  // 連続エラー時の共通処理(WebGLコンテキスト喪失などで撒き続けないよう自動OFF)
  function onInferError(e) {
    console.error(TAG, 'segment error:', e);
    if (++errCount >= 30) {
      notify('WebGLエラーのため「人物を避けてコメントを描画」をOFFにしました', 4000);
      const btn = document.getElementById('radio-comment-avoid');
      if (btn) btn.setAttribute('aria-pressed', 'false');
      stop();
    }
  }

  // ===== Worker 初期化(成功でtrue / 失敗でfalse=メインスレッド推論へ) =====
  // 注意: ページオリジン(live.nicovideo.jp)から chrome-extension:// のスクリプトを直接
  //   new Worker() するとクロスオリジンで拒否される。→ 拡張リソースを fetch して Blob URL 化し、
  //   同一オリジン扱いの Worker として生成する(Worker内の importScripts は拡張URLでアクセス可)。
  async function initWorker() {
    let blobUrl = null;
    try {
      const res = await fetch(chrome.runtime.getURL('personMaskWorker.js'));
      const code = await res.text();
      blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    } catch (e) {
      console.warn(TAG, 'Workerソース取得不可→メインスレッド推論にフォールバック:', e && e.message);
      return false;
    }
    return new Promise(function (resolve) {
      let w;
      try {
        w = new Worker(blobUrl);
      } catch (e) {
        console.warn(TAG, 'Worker生成不可→メインスレッド推論にフォールバック:', e && e.message);
        try { URL.revokeObjectURL(blobUrl); } catch (e2) {}
        return resolve(false);
      }
      let settled = false;
      // Worker構築後はBlob URLは不要(Workerはソースをロード済み)。少し遅延して解放。
      setTimeout(function () { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 5000);
      const to = setTimeout(function () {
        if (settled) return;
        settled = true;
        console.warn(TAG, 'Worker初期化タイムアウト→メインスレッド推論にフォールバック');
        try { w.terminate(); } catch (e) {}
        resolve(false);
      }, WORKER_INIT_TIMEOUT_MS);

      w.onmessage = function (e) {
        const m = e.data;
        if (!m) return;
        if (m.type === 'ready') {
          if (settled) return;
          settled = true; clearTimeout(to);
          worker = w; workerReady = true;
          console.log(TAG, 'Worker ready, backend =', m.backend);
          resolve(true);
        } else if (m.type === 'error') {
          if (settled) return;
          settled = true; clearTimeout(to);
          console.warn(TAG, 'Worker初期化エラー→メインスレッド推論にフォールバック:', m.message);
          try { w.terminate(); } catch (e) {}
          resolve(false);
        } else if (m.type === 'mask') {
          handleWorkerMask(m);
        } else if (m.type === 'frameError') {
          workerBusy = false;
          onInferError(new Error(m.message));
        }
      };
      w.onerror = function (err) {
        if (!settled) {
          settled = true; clearTimeout(to);
          console.warn(TAG, 'Worker onerror→メインスレッド推論にフォールバック:', err && err.message);
          try { w.terminate(); } catch (e) {}
          resolve(false);
        } else {
          workerBusy = false;
          onInferError(err);
        }
      };

      w.postMessage({
        type: 'init',
        tfUrl: chrome.runtime.getURL('tfjs/tf.min.js'),
        bsUrl: chrome.runtime.getURL('tfjs/body-segmentation.min.js'),
        modelUrl: chrome.runtime.getURL(MODEL_DIR + '/model.json'),
        modelType: MODEL_TYPE,
        threshold: FG_THRESHOLD
      });
    });
  }

  // ===== メインスレッド推論(フォールバック用) =====
  async function ensureSegmenter() {
    if (segmenter) return segmenter;
    console.log(TAG, 'TF.js backend/model 読込開始(メインスレッド)…');
    await tf.setBackend('webgl');
    await tf.ready();
    segmenter = await bodySegmentation.createSegmenter(
      bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation,
      {
        runtime: 'tfjs',
        modelType: MODEL_TYPE,
        modelUrl: chrome.runtime.getURL(MODEL_DIR + '/model.json')
      }
    );
    try {
      const warm = document.createElement('canvas');
      warm.width = WORK_LONG; warm.height = WORK_LONG;
      warm.getContext('2d').fillRect(0, 0, WORK_LONG, WORK_LONG);
      tf.engine().startScope();
      try {
        const p = await segmenter.segmentPeople(warm, { flipHorizontal: false });
        await bodySegmentation.toBinaryMask(p);
      } finally { tf.engine().endScope(); }
    } catch (e) { /* ウォームアップ失敗は無視 */ }
    console.log(TAG, 'segmenter 準備完了(メインスレッド)');
    return segmenter;
  }

  // 映像を縮小canvasへ描画して推論入力にする(メイン推論用)
  function drawWork(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = WORK_LONG / Math.max(vw, vh);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (!work) { work = document.createElement('canvas'); wctx = work.getContext('2d'); }
    if (work.width !== w) work.width = w;
    if (work.height !== h) work.height = h;
    wctx.drawImage(video, 0, 0, w, h);
    return work;
  }

  // メインスレッドで推論(startScope/endScopeでテンソル一括解放=GPUリーク防止)
  async function inferMain(video) {
    const input = drawWork(video);
    if (!input) return;
    let md = null;
    tf.engine().startScope();
    try {
      const people = await segmenter.segmentPeople(input, { flipHorizontal: false });
      md = await bodySegmentation.toBinaryMask(
        people,
        { r: 255, g: 255, b: 255, a: 255 },
        { r: 0, g: 0, b: 0, a: 0 },
        false,
        FG_THRESHOLD
      );
    } finally {
      tf.engine().endScope();
    }
    if (md) applyRawMask(md);
  }

  // Workerへ送るフレームを軽量に作って送信(createImageBitmapで縮小。transferでコピーなし)
  async function requestWorkerFrame(video) {
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) { workerBusy = false; return; }
      const scale = WORK_LONG / Math.max(vw, vh);
      const rw = Math.max(1, Math.round(vw * scale));
      const rh = Math.max(1, Math.round(vh * scale));
      const bmp = await createImageBitmap(video, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'low' });
      if (!running || !worker) { try { bmp.close(); } catch (e) {} workerBusy = false; return; }
      worker.postMessage({ type: 'frame', bitmap: bmp, seq: ++frameSeq }, [bmp]);
    } catch (e) {
      workerBusy = false;
      onInferError(e);
    }
  }

  // Workerから返ったマスク(二値)を受けて反映
  function handleWorkerMask(m) {
    workerBusy = false;
    if (!running) return;
    errCount = 0;
    if (m.empty || !m.data) return;
    const data = new Uint8ClampedArray(m.data);
    applyRawMask({ data: data, width: m.width, height: m.height });
  }

  // 二値マスク(人物=不透明/背景=透明)に EMA平滑化・膨張・ぼかしを適用して personMaskC を更新(共通)
  // raw: ImageData もしくは {data:Uint8ClampedArray, width, height}
  function applyRawMask(raw) {
    const w = raw.width, h = raw.height, d = raw.data;
    if (!w || !h || !d) return;
    if (!emaBuf || emaW !== w || emaH !== h) {
      emaBuf = new Float32Array(w * h); emaBuf.fill(0); emaW = w; emaH = h;
    }
    // EMA平滑化しつつ、平滑化値からの乖離(=人物がどれだけ動いたか)を動き量として集計
    let motionSum = 0;
    for (let i = 0, p = 3; i < emaBuf.length; i++, p += 4) {
      const nv = d[p];
      motionSum += (nv > emaBuf[i]) ? (nv - emaBuf[i]) : (emaBuf[i] - nv);
      emaBuf[i] += EMA_K * (nv - emaBuf[i]);
      d[p - 3] = 255; d[p - 2] = 255; d[p - 1] = 255; d[p] = emaBuf[i];
    }
    const motion = motionSum / emaBuf.length; // 1pxあたり平均アルファ変化(0-255)
    motionLevel += MOTION_EMA_K * (motion - motionLevel);
    if (MOTION_DEBUG) {
      const tnow = performance.now();
      if (tnow - motionDbgT0 > 1000) {
        motionDbgT0 = tnow;
        console.log(TAG, 'motion=' + motion.toFixed(1) + ' level=' + motionLevel.toFixed(1));
      }
    }

    const imgData = (typeof ImageData !== 'undefined' && raw instanceof ImageData)
      ? raw : new ImageData(d, w, h);

    if (!tmp) { tmp = document.createElement('canvas'); ttx = tmp.getContext('2d'); }
    if (tmp.width !== w) tmp.width = w;
    if (tmp.height !== h) tmp.height = h;
    ttx.putImageData(imgData, 0, 0);

    // パディング付きマスク(tpC): 人物が画面端に達している場合、端の画素を余白へ複製(edge-replicate)する。
    // こうするとぼかし/収縮の縁が「余白(=画面外)」側で起き、表示される画面端は不透明のまま保たれ、
    // 画面いっぱいに人物が映る時の「額縁状のズレ(端でコメントが透ける)」を防ぐ。人物が端に無い時は
    // 端が透明なので複製しても透明のまま=無害。
    const P = MASK_PAD;
    const W = w + 2 * P, H = h + 2 * P;
    if (!tpC) { tpC = document.createElement('canvas'); tpctx = tpC.getContext('2d'); }
    if (tpC.width !== W) tpC.width = W;
    if (tpC.height !== H) tpC.height = H;
    tpctx.clearRect(0, 0, W, H);
    if (P > 0) {
      // 角(端1×1画素 → P×P へ引き伸ばし)
      tpctx.drawImage(tmp, 0, 0, 1, 1, 0, 0, P, P);
      tpctx.drawImage(tmp, w - 1, 0, 1, 1, P + w, 0, P, P);
      tpctx.drawImage(tmp, 0, h - 1, 1, 1, 0, P + h, P, P);
      tpctx.drawImage(tmp, w - 1, h - 1, 1, 1, P + w, P + h, P, P);
      // 辺(端1px列/行 → 余白へ引き伸ばし)
      tpctx.drawImage(tmp, 0, 0, w, 1, P, 0, w, P);          // 上
      tpctx.drawImage(tmp, 0, h - 1, w, 1, P, P + h, w, P);  // 下
      tpctx.drawImage(tmp, 0, 0, 1, h, 0, P, P, h);          // 左
      tpctx.drawImage(tmp, w - 1, 0, 1, h, P + w, P, P, h);  // 右
    }
    tpctx.drawImage(tmp, P, P); // 中央(本体)

    if (!personMaskC) { personMaskC = document.createElement('canvas'); pmctx = personMaskC.getContext('2d'); }
    if (personMaskC.width !== W) personMaskC.width = W;
    if (personMaskC.height !== H) personMaskC.height = H;
    pmctx.clearRect(0, 0, W, H);
    // ぼかし量: 静止時はMASK_BLUR、動き量に応じてMASK_BLUR_MOTIONまで増加(境界をごまかして残像を目立たなくする)
    const motionT = Math.max(0, Math.min(1, (motionLevel - MOTION_LOW) / Math.max(1, MOTION_HIGH - MOTION_LOW)));
    const blur = MASK_BLUR + motionT * MASK_BLUR_MOTION;
    pmctx.filter = blur > 0 ? ('blur(' + blur.toFixed(1) + 'px)') : 'none';
    const r = MASK_DILATE;
    if (r > 0) {
      const offs = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]];
      for (let k = 0; k < offs.length; k++) pmctx.drawImage(tpC, offs[k][0], offs[k][1]);
    } else {
      pmctx.drawImage(tpC, 0, 0);
    }
    pmctx.filter = 'none';

    // 動き適応収縮: 激しい動きほどマスクを内側へ削る(前位置に残る切れ端=残像を減らす)。
    // 収縮量 er を動き量から算出し、自分自身を全方向へ er ずらして destination-in で重ねる
    // = 全方向でずれた位置すべてが不透明な画素だけ残る = 輪郭が er ぶん削れて収縮。
    if (MOTION_ADAPT) {
      let er = 0;
      if (motionLevel > MOTION_LOW) {
        const t = Math.min(1, (motionLevel - MOTION_LOW) / (MOTION_HIGH - MOTION_LOW));
        er = Math.round(t * MOTION_ERODE_MAX);
      }
      if (er > 0) {
        if (!erodeC) { erodeC = document.createElement('canvas'); erctx = erodeC.getContext('2d'); }
        if (erodeC.width !== W) erodeC.width = W;
        if (erodeC.height !== H) erodeC.height = H;
        erctx.clearRect(0, 0, W, H);
        erctx.drawImage(personMaskC, 0, 0);          // 現マスクを退避
        pmctx.globalCompositeOperation = 'destination-in';
        const eoffs = [[er, 0], [-er, 0], [0, er], [0, -er]]; // 4方向(上下左右)で侵食
        for (let k = 0; k < eoffs.length; k++) pmctx.drawImage(erodeC, eoffs[k][0], eoffs[k][1]);
        pmctx.globalCompositeOperation = 'source-over';
      }
    }
    if (!personReady) hideWaitOverlay(true);
    personReady = true;

    syncDrawModeAfterMask();
  }

  // ===== コメントマスク方式(hybrid の激しい時 / commentMask モード) =====
  // コメント層(#comment-layer-container)に CSS mask を当て、人物の形にコメントを透過させる。
  // overlay方式と違い「コメントに穴を開ける(穴の中は実映像)」だけなので、マスクがズレても人物が歪まない。
  // 点滅軽減: mask-image の URL 差し替えを避け、SVG mask 内 canvas のピクセルだけ更新する(svg 方式)。

  function scheduleRevokeObjectUrl(url) {
    if (!url || url.indexOf('blob:') !== 0) return;
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, CM_REVOKE_DELAY_MS);
  }

  function applyCommentMaskCssOnce(container) {
    const ref = 'url(#' + CM_MASK_DEF_ID + ')';
    container.style.setProperty('-webkit-mask-image', ref);
    container.style.setProperty('mask-image', ref);
    container.style.setProperty('-webkit-mask-size', '100% 100%');
    container.style.setProperty('mask-size', '100% 100%');
    container.style.setProperty('-webkit-mask-repeat', 'no-repeat');
    container.style.setProperty('mask-repeat', 'no-repeat');
    container.style.setProperty('isolation', 'isolate');
    var tr = container.style.transform;
    if (!tr || tr === 'none') container.style.setProperty('transform', 'translateZ(0)');
    cmMaskCssApplied = true;
  }

  function applyCommentMaskCssUrl(container, url) {
    const css = 'url("' + url + '")';
    container.style.setProperty('-webkit-mask-image', css);
    container.style.setProperty('mask-image', css);
    container.style.setProperty('-webkit-mask-size', '100% 100%');
    container.style.setProperty('mask-size', '100% 100%');
    container.style.setProperty('-webkit-mask-repeat', 'no-repeat');
    container.style.setProperty('mask-repeat', 'no-repeat');
    container.style.setProperty('isolation', 'isolate');
    var tr = container.style.transform;
    if (!tr || tr === 'none') container.style.setProperty('transform', 'translateZ(0)');
  }

  function clearCommentMaskCss(container) {
    if (!container) return;
    ['-webkit-mask-image', 'mask-image', '-webkit-mask-size', 'mask-size',
      '-webkit-mask-repeat', 'mask-repeat', 'isolation'].forEach(function (p) {
        container.style.removeProperty(p);
      });
    var tr = container.style.transform;
    if (tr === 'translateZ(0)') container.style.removeProperty('transform');
  }

  function removeCommentMaskSvg() {
    if (cmMaskSvg) { cmMaskSvg.remove(); cmMaskSvg = null; }
    cmMaskEl = null; cmMaskFo = null;
    cmMaskC = null; cmctx = null;
    cmMaskCssApplied = false;
  }

  function ensureCommentMaskSvg(mw, mh) {
    if (!cmMaskSvg) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = CM_MASK_SVG_ID;
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const mask = document.createElementNS('http://www.w3.org/2000/svg', 'mask');
      mask.id = CM_MASK_DEF_ID;
      mask.setAttribute('maskUnits', 'userSpaceOnUse');
      mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
      const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      fo.setAttribute('x', '0');
      fo.setAttribute('y', '0');
      const canvas = document.createElement('canvas');
      fo.appendChild(canvas);
      mask.appendChild(fo);
      defs.appendChild(mask);
      svg.appendChild(defs);
      document.body.appendChild(svg);
      cmMaskSvg = svg;
      cmMaskEl = mask;
      cmMaskFo = fo;
      cmMaskC = canvas;
      cmctx = canvas.getContext('2d');
    }
    if (cmMaskC.width !== mw) cmMaskC.width = mw;
    if (cmMaskC.height !== mh) cmMaskC.height = mh;
    cmMaskEl.setAttribute('width', String(mw));
    cmMaskEl.setAttribute('height', String(mh));
    cmMaskFo.setAttribute('width', String(mw));
    cmMaskFo.setAttribute('height', String(mh));
  }

  function ensureCommentMaskWorkCanvas(mw, mh) {
    if (!cmMaskC) { cmMaskC = document.createElement('canvas'); cmctx = cmMaskC.getContext('2d'); }
    if (cmMaskC.width !== mw) cmMaskC.width = mw;
    if (cmMaskC.height !== mh) cmMaskC.height = mh;
  }

  function ensureCommentMaskDoubleBuffer() {
    if (!cmImgA) {
      cmImgA = document.createElement('img');
      cmImgA.id = 'nicoPersonCommentMaskImgA';
      cmImgA.alt = '';
      cmImgA.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
      document.body.appendChild(cmImgA);
    }
    if (!cmImgB) {
      cmImgB = document.createElement('img');
      cmImgB.id = 'nicoPersonCommentMaskImgB';
      cmImgB.alt = '';
      cmImgB.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
      document.body.appendChild(cmImgB);
    }
  }

  function removeCommentMaskDoubleBuffer() {
    if (cmImgA) { cmImgA.remove(); cmImgA = null; }
    if (cmImgB) { cmImgB.remove(); cmImgB = null; }
    cmImgFlip = false;
  }

  function shouldApplyCommentMask() {
    if (!running) return false;
    if (drawMode === 'overlay') return false;
    if (drawMode === 'hybrid' && !cmActive) return false;
    return true;
  }

  // マスクcanvasへ「人物=透明/その他=白(コメント表示)」を描く(方式共通)
  function drawCommentMaskPixels(mw, mh, ew, eh, vw, vh) {
    cmctx.setTransform(1, 0, 0, 1, 0, 0);
    cmctx.globalCompositeOperation = 'source-over';
    cmctx.clearRect(0, 0, mw, mh);
    cmctx.fillStyle = '#fff';
    cmctx.fillRect(0, 0, mw, mh);
    const s = Math.min(ew / vw, eh / vh);
    const cw = vw * s * (mw / ew), ch = vh * s * (mh / eh);
    const ox = (mw - cw) / 2, oy = (mh - ch) / 2;
    const P = MASK_PAD;
    const pmw = personMaskC.width - 2 * P, pmh = personMaskC.height - 2 * P;
    cmctx.globalCompositeOperation = 'destination-out';
    if (isHanten()) {
      cmctx.save();
      cmctx.translate(ox + cw, oy); cmctx.scale(-1, 1);
      cmctx.drawImage(personMaskC, P, P, pmw, pmh, 0, 0, cw, ch);
      cmctx.restore();
    } else {
      cmctx.drawImage(personMaskC, P, P, pmw, pmh, ox, oy, cw, ch);
    }
    cmctx.globalCompositeOperation = 'source-over';
  }

  function applyCommentMaskBlob(container) {
    cmMaskC.toBlob(function (blob) {
      if (!blob || !shouldApplyCommentMask()) return;
      const url = URL.createObjectURL(blob);
      applyCommentMaskCssUrl(container, url);
      if (cmPrevUrl) scheduleRevokeObjectUrl(cmPrevUrl);
      cmPrevUrl = url;
    }, 'image/png');
  }

  function applyCommentMaskDoubleBuffer(container) {
    ensureCommentMaskDoubleBuffer();
    cmMaskC.toBlob(function (blob) {
      if (!blob || !shouldApplyCommentMask()) return;
      const nextImg = cmImgFlip ? cmImgB : cmImgA;
      const url = URL.createObjectURL(blob);
      nextImg.onload = function () {
        nextImg.onload = null;
        if (!shouldApplyCommentMask()) {
          scheduleRevokeObjectUrl(url);
          return;
        }
        applyCommentMaskCssUrl(container, url);
        cmImgFlip = !cmImgFlip;
        if (cmPrevUrl) scheduleRevokeObjectUrl(cmPrevUrl);
        cmPrevUrl = url;
      };
      nextImg.onerror = function () {
        nextImg.onerror = null;
        scheduleRevokeObjectUrl(url);
      };
      nextImg.src = url;
    }, 'image/png');
  }

  function deactivateCommentMask() {
    if (!cmActive) return;
    clearCommentMaskCss(getCommentContainer());
    cmMaskCssApplied = false;
    if (cmPrevUrl) {
      scheduleRevokeObjectUrl(cmPrevUrl);
      cmPrevUrl = null;
    }
    cmActive = false;
  }

  function teardownCommentMaskInfra() {
    clearCommentMaskCss(getCommentContainer());
    cmMaskCssApplied = false;
    if (cmPrevUrl) {
      scheduleRevokeObjectUrl(cmPrevUrl);
      cmPrevUrl = null;
    }
    cmActive = false;
    removeCommentMaskSvg();
    removeCommentMaskDoubleBuffer();
    cmLastUpdate = 0;
  }

  // personMaskC からコメントマスクを生成し適用(方式は CM_MASK_STRATEGY)
  function buildAndApplyCommentMask(container) {
    const now = performance.now();
    if (now - cmLastUpdate < CM_MASK_UPDATE_MS) return;
    const ew = container.clientWidth, eh = container.clientHeight;
    const video = getVideo();
    const vw = video ? video.videoWidth : 0, vh = video ? video.videoHeight : 0;
    if (!ew || !eh || !vw || !vh || !personMaskC) return;
    const ms = CM_MASK_LONG / Math.max(ew, eh);
    const mw = Math.max(1, Math.round(ew * ms)), mh = Math.max(1, Math.round(eh * ms));

    if (CM_MASK_STRATEGY === 'svg') {
      ensureCommentMaskSvg(mw, mh);
      drawCommentMaskPixels(mw, mh, ew, eh, vw, vh);
      if (!cmMaskCssApplied) applyCommentMaskCssOnce(container);
    } else {
      ensureCommentMaskWorkCanvas(mw, mh);
      drawCommentMaskPixels(mw, mh, ew, eh, vw, vh);
      if (CM_MASK_STRATEGY === 'doubleBuffer') applyCommentMaskDoubleBuffer(container);
      else applyCommentMaskBlob(container);
    }
    cmLastUpdate = now;
  }

  // 重ね描画用canvasをコメントコンテナ直下に用意し、コメント領域(=映像表示域)にぴったり重ねる
  function ensureOverlay(container) {
    if (!overlayC) {
      overlayC = document.createElement('canvas');
      overlayC.id = 'nicoPersonCutout';
      overlayC.style.cssText =
        'position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none;';
      ovctx = overlayC.getContext('2d');
    }
    if (overlayC.parentElement !== container) {
      container.appendChild(overlayC);
      const cc = container.querySelector('canvas:not(#nicoPersonCutout)');
      const z = cc ? getComputedStyle(cc).zIndex : 'auto';
      overlayC.style.zIndex = (z && z !== 'auto') ? z : '';
    }
  }

  // 映像から人物だけを切り出し、ギフト/ゲーム領域を除外して、コメントの上へ描画する
  function drawCutout(video) {
    if (drawMode === 'commentMask') return; // コメントマスク専用モードでは overlay canvas を作らない
    const container = getCommentContainer();
    if (!container) return;
    const ew = container.clientWidth, eh = container.clientHeight;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!ew || !eh || !vw || !vh) return;
    ensureOverlay(container);
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const bw = Math.max(1, Math.round(ew * dpr)), bh = Math.max(1, Math.round(eh * dpr));
    if (overlayC.width !== bw) overlayC.width = bw;
    if (overlayC.height !== bh) overlayC.height = bh;

    ovctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ovctx.clearRect(0, 0, ew, eh);
    if (!personReady || !personMaskC) return;

    // hybrid でコメントマスク方式中、または overlay 専用でない場合の保険
    if (drawMode === 'hybrid' && cmActive) return;
    if (drawMode === 'overlay' && cmActive) deactivateCommentMask();

    const s = Math.min(ew / vw, eh / vh);
    const cw = vw * s, ch = vh * s;
    const ox = (ew - cw) / 2, oy = (eh - ch) / 2;

    ovctx.save();
    if (isHanten()) { ovctx.translate(2 * ox + cw, 0); ovctx.scale(-1, 1); }
    if (DEBUG_OVERLAY) {
      ovctx.fillStyle = 'rgba(255,0,0,0.5)';
      ovctx.fillRect(ox, oy, cw, ch);
    } else {
      ovctx.drawImage(video, ox, oy, cw, ch);          // 常に最新の生映像を切り抜く
    }
    ovctx.globalCompositeOperation = 'destination-in';
    // personMaskC は余白(MASK_PAD)付き。中央のコンテンツ領域(=映像フレームに対応)だけをコンテンツ矩形へ写す。
    const P = MASK_PAD;
    const mw = personMaskC.width - 2 * P, mh = personMaskC.height - 2 * P;
    ovctx.drawImage(personMaskC, P, P, mw, mh, ox, oy, cw, ch);
    ovctx.restore();

    const gifts = getGiftCanvases();
    if (gifts.length) {
      ovctx.globalCompositeOperation = 'destination-out';
      const gd = GIFT_DILATE;
      for (let i = 0; i < gifts.length; i++) {
        const g = gifts[i];
        if (!g.width || !g.height) continue;
        try { ovctx.drawImage(g, ox - gd, oy - gd, cw + 2 * gd, ch + 2 * gd); } catch (e) { /* 念のため */ }
      }
      ovctx.globalCompositeOperation = 'source-over';
    }
  }

  // 1ティック分の処理: 重ね描画 +(間隔が来ていれば)人物マスク推定(Worker or メイン)
  function tick(forceDraw, segInterval) {
    if (running && !personReady && (!waitOverlayEl || !waitOverlayEl.classList.contains('is-visible'))) {
      showWaitOverlay();
    }
    const video = getVideo();
    if (!video || video.paused || video.readyState < 2) return;
    const now = performance.now();
    if (forceDraw || (now - lastDraw) >= DRAW_THROTTLE_MS) { lastDraw = now; drawCutout(video); }
    if ((now - lastInfer) < segInterval) return;
    if (useWorker) {
      if (workerReady && !workerBusy) { lastInfer = now; workerBusy = true; requestWorkerFrame(video); }
    } else {
      if (!inferBusy) {
        lastInfer = now; inferBusy = true;
        inferMain(video)
          .then(function () { errCount = 0; })
          .catch(onInferError)
          .then(function () { inferBusy = false; });
      }
    }
  }

  // 描画ループ。動画フレーム提示に同期できる requestVideoFrameCallback を優先(裏映像と同フレーム＝残像が出ない)。
  function rvfcLoop(now) {
    if (!running) return;
    if (typeof now === 'number' && lastFrameTs && now > lastFrameTs) {
      const dt = now - lastFrameTs;
      if (dt > 0 && dt < 1000) segIntervalMs += 0.1 * (dt - segIntervalMs); // 映像fpsに追従(EMA)
    }
    lastFrameTs = (typeof now === 'number') ? now : performance.now();
    tick(true, Math.max(segIntervalMs, SEG_MIN_INTERVAL_MS));
    armDrawLoop();
  }
  function rafLoop() {
    if (!running) return;
    tick(false, SEG_THROTTLE_MS);
    rafId = requestAnimationFrame(rafLoop);
  }
  function armDrawLoop() {
    if (!running) return;
    const video = getVideo();
    if (video && typeof video.requestVideoFrameCallback === 'function') {
      rvfcVideo = video;
      rvfcId = video.requestVideoFrameCallback(rvfcLoop);
    } else {
      rafId = requestAnimationFrame(rafLoop);
    }
  }

  async function start() {
    if (running) return true;
    showWaitOverlay();

    if (!worker && !segmenter) {
      // 初回: Worker優先。失敗したらメインスレッド推論にフォールバック。
      const ok = await initWorker();
      if (ok) {
        useWorker = true;
      } else {
        useWorker = false;
        try {
          await ensureSegmenter();
        } catch (e) {
          console.error(TAG, '初期化失敗:', e);
          hideWaitOverlay();
          notify('人物を避けてコメントを描画：初期化に失敗しました', 4000);
          return false;
        }
      }
    } else {
      // 2回目以降: 既存のWorker/segmenterを再利用
      useWorker = !!worker;
    }

    running = true;
    lastInfer = 0;
    lastFrameTs = 0;
    segIntervalMs = SEG_THROTTLE_MS;
    personReady = false;
    errCount = 0;
    workerBusy = false;
    motionLevel = 0;
    motionDbgT0 = 0;
    cmActive = false;
    showWaitOverlay();
    armDrawLoop();
    console.log(TAG, 'ON (useWorker=' + useWorker + ')');
    return true;
  }

  function stop() {
    running = false;
    hideWaitOverlay();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (rvfcId && rvfcVideo && typeof rvfcVideo.cancelVideoFrameCallback === 'function') {
      rvfcVideo.cancelVideoFrameCallback(rvfcId);
    }
    rvfcId = 0; rvfcVideo = null;
    if (overlayC) { overlayC.remove(); overlayC = null; ovctx = null; }
    teardownCommentMaskInfra();
    personMaskC = null; pmctx = null;
    erodeC = null; erctx = null;
    tpC = null; tpctx = null;
    emaBuf = null; emaW = 0; emaH = 0;
    personReady = false;
    workerBusy = false;
    // worker は破棄せず保持(再ONを速くするため。アイドル時は推論しないのでGPUメモリはモデル分で一定)。
    console.log(TAG, 'OFF');
  }

  // 描画モード切替(比較用)。実行中でも切替可。戻り値=false は mode 不正。
  function setDrawMode(mode) {
    if (!isValidDrawMode(mode)) return false;
    drawMode = mode;
    if (!running) return true;
    if (mode === 'commentMask') {
      cmActive = true;
      if (personReady) {
        const container = getCommentContainer();
        if (container) buildAndApplyCommentMask(container);
      }
    } else if (mode === 'overlay') {
      deactivateCommentMask();
    } else {
      deactivateCommentMask(); // hybrid: 静止側(overlay)から再開
    }
    console.log(TAG, 'drawMode=' + mode);
    return true;
  }

  // main.js のトグルから呼べるよう公開
  window.NicoPersonMask = {
    start: start,
    stop: stop,
    isRunning: function () { return running; },
    getDrawMode: function () { return drawMode; },
    setDrawMode: setDrawMode,
    notify: notify
  };
})();
