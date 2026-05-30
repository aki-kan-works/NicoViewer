// personMask.js — 「人物を避けてコメントを描画」機能
//
// TF.js(WebGLバックエンド) + MediaPipe Selfie Segmentation(tfjs runtime / ローカル同梱モデル) で
// 配信映像から人物領域をリアルタイム推定する。
//
// 【描画方式】コメント層には一切触れず、映像から切り出した「人物だけ」をコメントの“上”に重ねて描画する。
//   → 人物がコメントの手前に出る＝人物の上のコメントが隠れる（公式スマホアプリ相当）。
//   ※コメント層に CSS マスクを当てる方式は、ニコ生が毎フレーム再描画するコメントcanvasと
//     マスク合成が競合して層全体がストロボ状に点滅するため不可（再導入しないこと）。本方式はコメント層を
//     触らないのでその種のチラつきが出ない。人物の切り出しは元映像と同ピクセルを同位置に描くので継ぎ目なし。
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
  const WORK_LONG = 256;        // 推論入力の長辺px(モデル入力が256のため256で十分)
  const FG_THRESHOLD = 0.4;     // 人物と判定する確信度。低いほどハッキリ(背景の誤検出は増える / 既定0.5)
  const MASK_DILATE = 2;        // 人物マスクの膨張px(work解像度基準)。大きいほど人物の外側まで余裕を持って隠す
  const MASK_BLUR = 2;          // 人物マスク境界のぼかしpx(切り出しの縁をふんわり)
  const EMA_K = 0.7;           // 人物マスクの時間平滑化係数(0〜1)。大きいほど動きに速く追従(残像減)だが境界が少し揺れる
  const GIFT_DILATE = 8;        // ギフト/ゲーム削り取りの膨張px(CSS座標)。大きいほど高速移動ギフトの残像を抑える(負荷増)
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
  let toastEl = null, toastTm = null;    // 自前トースト(ニコ生スナックバーは再描画で消えるため使わない)

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

  // 映像の中央に短く表示する自前トースト。映像コンテナ直下に置き全画面表示中も見えるようにする。ms=0は消さない。
  function notify(msg, ms) {
    const video = getVideo();
    const host = (video && video.parentElement)
      || document.querySelector('[class*="___video-layer___"]')
      || document.body;
    if (!toastEl || !document.body.contains(toastEl)) {
      toastEl = document.createElement('div');
      toastEl.id = 'nicoPersonMaskToast';
      toastEl.style.cssText =
        'left:50%; top:50%; transform:translate(-50%,-50%); z-index:2147483647;' +
        'background:rgba(37,37,37,.92); color:#fff; padding:8px 16px; border-radius:6px;' +
        'font-size:14px; font-family:sans-serif; box-shadow:0 0 8px rgba(0,0,0,.6);' +
        'pointer-events:none; white-space:nowrap; opacity:0; transition:opacity .2s ease;';
    }
    if (toastEl.parentElement !== host) host.appendChild(toastEl);
    toastEl.style.position = (host === document.body) ? 'fixed' : 'absolute';
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
        modelUrl: chrome.runtime.getURL('models/selfie-segmentation/model.json'),
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
        modelType: 'general',
        modelUrl: chrome.runtime.getURL('models/selfie-segmentation/model.json')
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
    for (let i = 0, p = 3; i < emaBuf.length; i++, p += 4) {
      emaBuf[i] += EMA_K * (d[p] - emaBuf[i]);
      d[p - 3] = 255; d[p - 2] = 255; d[p - 1] = 255; d[p] = emaBuf[i];
    }
    const imgData = (typeof ImageData !== 'undefined' && raw instanceof ImageData)
      ? raw : new ImageData(d, w, h);

    if (!tmp) { tmp = document.createElement('canvas'); ttx = tmp.getContext('2d'); }
    if (tmp.width !== w) tmp.width = w;
    if (tmp.height !== h) tmp.height = h;
    ttx.putImageData(imgData, 0, 0);

    if (!personMaskC) { personMaskC = document.createElement('canvas'); pmctx = personMaskC.getContext('2d'); }
    if (personMaskC.width !== w) personMaskC.width = w;
    if (personMaskC.height !== h) personMaskC.height = h;
    pmctx.clearRect(0, 0, w, h);
    pmctx.filter = MASK_BLUR > 0 ? ('blur(' + MASK_BLUR + 'px)') : 'none';
    const r = MASK_DILATE;
    if (r > 0) {
      const offs = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]];
      for (let k = 0; k < offs.length; k++) pmctx.drawImage(tmp, offs[k][0], offs[k][1]);
    } else {
      pmctx.drawImage(tmp, 0, 0);
    }
    pmctx.filter = 'none';
    personReady = true;
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

    const s = Math.min(ew / vw, eh / vh);
    const cw = vw * s, ch = vh * s;
    const ox = (ew - cw) / 2, oy = (eh - ch) / 2;

    ovctx.save();
    if (isHanten()) { ovctx.translate(2 * ox + cw, 0); ovctx.scale(-1, 1); }
    if (DEBUG_OVERLAY) {
      ovctx.fillStyle = 'rgba(255,0,0,0.5)';
      ovctx.fillRect(ox, oy, cw, ch);
    } else {
      ovctx.drawImage(video, ox, oy, cw, ch);
    }
    ovctx.globalCompositeOperation = 'destination-in';
    ovctx.drawImage(personMaskC, ox, oy, cw, ch);
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
    const firstLoad = !worker && !segmenter;
    if (firstLoad) notify('人物を避けてコメントを描画：準備中…', 0);

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
    armDrawLoop();
    notify('人物を避けてコメントを描画：ON' + (useWorker ? '' : '（互換モード）'), 1500);
    console.log(TAG, 'ON (useWorker=' + useWorker + ')');
    return true;
  }

  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (rvfcId && rvfcVideo && typeof rvfcVideo.cancelVideoFrameCallback === 'function') {
      rvfcVideo.cancelVideoFrameCallback(rvfcId);
    }
    rvfcId = 0; rvfcVideo = null;
    if (overlayC) { overlayC.remove(); overlayC = null; ovctx = null; }
    personMaskC = null; pmctx = null;
    emaBuf = null; emaW = 0; emaH = 0;
    personReady = false;
    workerBusy = false;
    // worker は破棄せず保持(再ONを速くするため。アイドル時は推論しないのでGPUメモリはモデル分で一定)。
    console.log(TAG, 'OFF');
  }

  // main.js のトグルから呼べるよう公開
  window.NicoPersonMask = {
    start: start,
    stop: stop,
    isRunning: function () { return running; },
    notify: notify
  };
})();
