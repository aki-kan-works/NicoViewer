// personMaskWorker.js — 人物セグメンテーションを別スレッド(Web Worker)で実行する
//
// 目的: 重いGPU推論(segmentPeople)をメインスレッドから分離し、ニコ生のコメント描画の
//   カクつきを抑える。Worker内では OffscreenCanvas + WebGL で TF.js を動かす。
//   ※Worker は chrome-extension:// オリジンで動くため、拡張のCSP(wasm-unsafe-eval等)が適用され、
//     同一オリジンの importScripts / モデルfetch が可能。
//
// メイン(personMask.js)との protocol:
//   ← {type:'init', tfUrl, bsUrl, modelUrl, threshold}  初期化(ライブラリURL・モデルURL・しきい値)
//   → {type:'ready'} / {type:'error', message}
//   ← {type:'frame', bitmap, seq}                        推論するフレーム(ImageBitmap, transfer)
//   → {type:'mask', seq, width, height, data(buffer)} / {type:'frameError', seq, message}
//
// メモリリーク対策: 推論〜マスク生成を startScope/endScope で囲み毎回テンソルを一括解放する
//   (これが無いとGPUメモリが積み上がりコンテキスト喪失する)。

let tf = null;
let bodySegmentation = null;
let segmenter = null;
let fgThreshold = 0.4;

const FG = { r: 255, g: 255, b: 255, a: 255 }; // 人物 → 不透明(残す)
const BG = { r: 0, g: 0, b: 0, a: 0 };         // 背景 → 透明(切り落とす)

async function handleInit(msg) {
  try {
    fgThreshold = (typeof msg.threshold === 'number') ? msg.threshold : 0.4;
    importScripts(msg.tfUrl, msg.bsUrl); // 同一オリジン(chrome-extension://)なので許可される
    tf = self.tf;
    bodySegmentation = self.bodySegmentation;
    if (!tf || !bodySegmentation) throw new Error('library not loaded in worker');

    await tf.setBackend('webgl'); // Worker内では OffscreenCanvas ベースのWebGLを使用
    await tf.ready();

    segmenter = await bodySegmentation.createSegmenter(
      bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation,
      { runtime: 'tfjs', modelType: (msg.modelType || 'general'), modelUrl: msg.modelUrl }
    );

    // ウォームアップ(WebGLシェーダの事前コンパイル)
    try {
      const warm = new OffscreenCanvas(256, 256);
      const wc = warm.getContext('2d');
      wc.fillRect(0, 0, 256, 256);
      tf.engine().startScope();
      try {
        const p = await segmenter.segmentPeople(warm, { flipHorizontal: false });
        await bodySegmentation.toBinaryMask(p, FG, BG, false, fgThreshold);
      } finally { tf.engine().endScope(); }
    } catch (e) { /* ウォームアップ失敗は無視 */ }

    self.postMessage({ type: 'ready', backend: tf.getBackend() });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
}

async function handleFrame(msg) {
  const bitmap = msg.bitmap;
  if (!segmenter) { try { bitmap && bitmap.close && bitmap.close(); } catch (e) {} return; }
  try {
    let md = null;
    tf.engine().startScope();
    try {
      const people = await segmenter.segmentPeople(bitmap, { flipHorizontal: false });
      md = await bodySegmentation.toBinaryMask(people, FG, BG, false, fgThreshold);
    } finally {
      tf.engine().endScope();
    }
    try { bitmap && bitmap.close && bitmap.close(); } catch (e) {}

    if (md && md.data) {
      // data(Uint8ClampedArray) の buffer を transfer でメインへ返す(コピーなし)
      self.postMessage(
        { type: 'mask', seq: msg.seq, width: md.width, height: md.height, data: md.data.buffer },
        [md.data.buffer]
      );
    } else {
      self.postMessage({ type: 'mask', seq: msg.seq, empty: true });
    }
  } catch (err) {
    try { bitmap && bitmap.close && bitmap.close(); } catch (e) {}
    self.postMessage({ type: 'frameError', seq: msg.seq, message: String((err && err.message) || err) });
  }
}

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'init') handleInit(msg);
  else if (msg.type === 'frame') handleFrame(msg);
};
