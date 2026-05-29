// personMask.js — 「人物を避けてコメントを描画」機能
//
// TF.js(WebGLバックエンド) + MediaPipe Selfie Segmentation(tfjs runtime / ローカル同梱モデル) で
// 配信映像から人物領域をリアルタイム推定する。
//
// 【描画方式】コメント層には一切触れず、映像から切り出した「人物だけ」をコメントの“上”に重ねて描画する。
//   → 人物がコメントの手前に出る＝人物の上のコメントが隠れる（公式スマホアプリ相当）。
//   コメント層にCSSマスクを当てて毎フレーム差し替える旧方式は、差し替え時の再合成でコメント全体が
//   チラついたため廃止。本方式はコメント層を変更しないのでその種のチラつきが原理的に出ない。
//   人物の切り出しは元映像と同じピクセルを同じ位置へ描くので、実映像と継ぎ目なく重なる。
//
// 制御は拡張メニューの「人物を避けてコメントを描画」トグル(main.js #radio-comment-avoid)から
// window.NicoPersonMask.start()/stop() で行う。
//
// 非破壊: コメント層(#comment-layer-container)の直下に重ね描画用 <canvas> を1枚追加するだけ。
//   コメント層のスタイル等は変更しない。OFF/停止で canvas を除去＝完全可逆。

(function () {
  const TAG = '[personMask]';

  // ===== 調整パラメータ =====
  const SEG_THROTTLE_MS = 50;   // 人物セグメンテーションの実行間隔(約11fps)
  const DRAW_THROTTLE_MS = 33;  // 重ね描画の間隔(約30fps)。負荷を抑える。0で毎フレーム
  const DPR_CAP = 1;          // 重ね描画canvasの解像度上限(devicePixelRatioの上限)。下げると軽く粗く
  const WORK_LONG = 256;        // 推論入力の長辺px(モデル入力が256のため256で十分)
  const FG_THRESHOLD = 0.4;     // 人物と判定する確信度。低いほどハッキリ(背景の誤検出は増える / 既定0.5)
  const MASK_DILATE = 2;        // 人物マスクの膨張px(work解像度基準)。大きいほど人物の外側まで余裕を持って隠す
  const MASK_BLUR = 2;          // 人物マスク境界のぼかしpx(切り出しの縁をふんわり)
  const EMA_K = 0.35;           // 人物マスクの時間平滑化係数(0〜1)。小さいほど安定するが追従が遅い
  const DEBUG_OVERLAY = false;  // true で人物切り出しを赤半透明で表示(検証用)

  let segmenter = null;
  let running = false;
  let rafId = null;
  let lastInfer = 0;
  let lastDraw = 0;             // 重ね描画の間引き用
  let inferBusy = false;        // セグメンテーションの多重実行防止
  let personReady = false;      // 最初の人物マスクが用意できたか

  let work = null, wctx = null;         // 推論入力用の縮小canvas
  let tmp = null, ttx = null;           // toBinaryMaskのImageData受け
  let personMaskC = null, pmctx = null; // 人物マスク(人物=不透明/背景=透明、ぼかし済み・work解像度)
  let emaBuf = null, emaW = 0, emaH = 0; // EMA用アルファバッファ
  let overlayC = null, ovctx = null;    // コメントの上に重ねる人物切り出しcanvas
  let toastEl = null, toastTm = null;   // 自前トースト(ニコ生スナックバーは再描画で消えるため使わない)

  function getVideo() {
    return document.querySelector('[class*="___video-layer___"] video');
  }
  function getCommentContainer() {
    return document.getElementById('comment-layer-container');
  }
  // 画面反転(main.jsの#radio-hanten)が有効か
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

  async function ensureSegmenter() {
    if (segmenter) return segmenter;
    console.log(TAG, 'TF.js backend/model 読込開始…');
    await tf.setBackend('webgl');
    await tf.ready();
    console.log(TAG, 'tf backend =', tf.getBackend());
    segmenter = await bodySegmentation.createSegmenter(
      bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation,
      {
        runtime: 'tfjs',
        modelType: 'general',
        modelUrl: chrome.runtime.getURL('models/selfie-segmentation/model.json')
      }
    );
    // ウォームアップ: ダミー入力で1回推論し、WebGLシェーダを事前コンパイル(初回ONのカクつき低減)
    try {
      const warm = document.createElement('canvas');
      warm.width = WORK_LONG; warm.height = WORK_LONG;
      warm.getContext('2d').fillRect(0, 0, WORK_LONG, WORK_LONG);
      const p = await segmenter.segmentPeople(warm, { flipHorizontal: false });
      await bodySegmentation.toBinaryMask(p);
    } catch (e) { /* ウォームアップ失敗は無視 */ }
    console.log(TAG, 'segmenter 準備完了');
    return segmenter;
  }

  // 映像を縮小canvasへ描画して推論入力にする(drawImageはCORS非汚染で成功)
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

  // 人物セグメンテーションを実行し、人物マスク(人物=不透明/背景=透明、ぼかし済み)を更新する(約11fps)
  async function updatePersonMask(video) {
    const input = drawWork(video);
    if (!input) return;
    const people = await segmenter.segmentPeople(input, { flipHorizontal: false });
    const md = await bodySegmentation.toBinaryMask(
      people,
      { r: 255, g: 255, b: 255, a: 255 }, // 人物(前景) → 不透明(切り出して残す)
      { r: 0, g: 0, b: 0, a: 0 },         // 背景 → 透明(切り落とす)
      false,
      FG_THRESHOLD
    );
    if (!md) return;

    // EMA時間平滑化(アルファ=人物確度)
    const w = md.width, h = md.height, d = md.data;
    if (!emaBuf || emaW !== w || emaH !== h) {
      emaBuf = new Float32Array(w * h); emaBuf.fill(0); emaW = w; emaH = h; // 初期=全面背景(切り落とし)
    }
    for (let i = 0, p = 3; i < emaBuf.length; i++, p += 4) {
      emaBuf[i] += EMA_K * (d[p] - emaBuf[i]);
      d[p - 3] = 255; d[p - 2] = 255; d[p - 1] = 255; d[p] = emaBuf[i];
    }
    if (!tmp) { tmp = document.createElement('canvas'); ttx = tmp.getContext('2d'); }
    if (tmp.width !== w) tmp.width = w;
    if (tmp.height !== h) tmp.height = h;
    ttx.putImageData(md, 0, 0);

    if (!personMaskC) { personMaskC = document.createElement('canvas'); pmctx = personMaskC.getContext('2d'); }
    if (personMaskC.width !== w) personMaskC.width = w;
    if (personMaskC.height !== h) personMaskC.height = h;
    pmctx.clearRect(0, 0, w, h);
    pmctx.filter = MASK_BLUR > 0 ? ('blur(' + MASK_BLUR + 'px)') : 'none';
    // 膨張: 人物(不透明)を上下左右斜めにずらして重ね描き、人物より外側まで領域を広げる
    // → コメントが人物を“余裕を持って”避ける
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
        'position:absolute; left:0; top:0; width:100%; height:100%;' +
        'pointer-events:none; z-index:2147483646;';
      ovctx = overlayC.getContext('2d');
    }
    // コメントコンテナ直下に置く(コメントcanvasの上)。再描画で外れたら付け直す
    if (overlayC.parentElement !== container) container.appendChild(overlayC);
  }

  // 映像から人物だけを切り出し、コメントの上へ毎フレーム描画する
  function drawCutout(video) {
    const container = getCommentContainer();
    if (!container) return;
    const ew = container.clientWidth, eh = container.clientHeight;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!ew || !eh || !vw || !vh) return;
    ensureOverlay(container);
    // HiDPIでも人物切り出しがボケないよう devicePixelRatio 分の解像度で保持(上限 DPR_CAP)
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const bw = Math.max(1, Math.round(ew * dpr)), bh = Math.max(1, Math.round(eh * dpr));
    if (overlayC.width !== bw) overlayC.width = bw;
    if (overlayC.height !== bh) overlayC.height = bh;

    ovctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 以降はCSSピクセル座標で描画
    ovctx.clearRect(0, 0, ew, eh);
    if (!personReady || !personMaskC) return; // 最初のマスクができるまでは透明のまま

    // 映像コンテンツ矩形(object-fit: contain。レターボックス対応)
    const s = Math.min(ew / vw, eh / vh);
    const cw = vw * s, ch = vh * s;
    const ox = (ew - cw) / 2, oy = (eh - ch) / 2;

    ovctx.save();
    if (isHanten()) { ovctx.translate(2 * ox + cw, 0); ovctx.scale(-1, 1); } // 画面反転に合わせ左右反転
    if (DEBUG_OVERLAY) {
      ovctx.fillStyle = 'rgba(255,0,0,0.5)';
      ovctx.fillRect(ox, oy, cw, ch);
    } else {
      ovctx.drawImage(video, ox, oy, cw, ch);          // 映像(人物+背景)を一旦描画
    }
    ovctx.globalCompositeOperation = 'destination-in';  // 人物マスクの不透明部分だけ残す
    ovctx.drawImage(personMaskC, ox, oy, cw, ch);
    ovctx.globalCompositeOperation = 'source-over';
    ovctx.restore();
  }

  function loop() {
    if (!running) return;
    const video = getVideo();
    if (video && !video.paused && video.readyState >= 2) {
      const now = performance.now();
      if ((now - lastDraw) >= DRAW_THROTTLE_MS) { lastDraw = now; drawCutout(video); }
      if (!inferBusy && (now - lastInfer) >= SEG_THROTTLE_MS) {
        lastInfer = now; inferBusy = true;
        updatePersonMask(video)
          .catch(function (e) { console.error(TAG, 'segment error:', e); })
          .then(function () { inferBusy = false; });
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  async function start() {
    if (running) return true;
    const firstLoad = !segmenter;
    if (firstLoad) notify('人物を避けてコメントを描画：準備中…', 0); // 初回はモデル読込で一瞬重い
    try {
      await ensureSegmenter();
    } catch (e) {
      console.error(TAG, '初期化失敗:', e);
      notify('人物を避けてコメントを描画：初期化に失敗しました', 4000);
      return false;
    }
    running = true;
    lastInfer = 0;
    personReady = false;
    loop();
    notify('人物を避けてコメントを描画：ON', 1500);
    console.log(TAG, 'ON');
    return true;
  }

  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (overlayC) { overlayC.remove(); overlayC = null; ovctx = null; }
    personMaskC = null; pmctx = null;
    emaBuf = null; emaW = 0; emaH = 0;
    personReady = false;
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
