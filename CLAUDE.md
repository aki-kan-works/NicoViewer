# CLAUDE.md

## 回答方針
- 日本語で回答すること。

## 実装方針

- **非破壊優先**: 実装済みの機能を破壊しない、または破壊リスクの少ない実装方法を優先する。
  - 実現が難しい場合は、その旨を回答したうえで、破壊的な実装方法を「提案のみ」行い、実装は進めない。
- **可読性重視**: 人間が見ても把握しやすいコーディングを心がける。

---

## 拡張機能概要

**NicoViewer**（manifest名 `NicoViewer` / 作者: なかむーら）は、ニコニコ生放送の視聴体験を拡張するChrome拡張機能（Manifest V3）。

### 動作対象ページ（content script）

```
https://live.nicovideo.jp/watch/*
https://live2.nicovideo.jp/watch/*
```

### 拡張機能アイコン（popup / side panel）

- ツールバーアイコンクリックで番組一覧ポップアップ／サイドパネルを表示。

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `manifest.json` | 拡張機能定義（MV3）。content_scripts / background / popup / side_panel を登録。 |
| `main.js` | **視聴ページ上の主要機能**（拡張メニュー・ワイプ・コメント描画拡張・URLを開く 等）。content script の中心。 |
| `capture.js` | 配信映像のキャプチャ処理（動画録画 / 静止画）。`main.js` から呼び出される。 |
| `jimp.min.js` | 画像処理ライブラリ（キャプチャ時のクロップ・スケール）。 |
| `background.js` | service worker。ダウンロード処理・タブキャプチャ・配信中件数のバッジ表示。 |
| `popup.html` / `popup.js` | 拡張機能アイコンの番組一覧UI（タブ切り替え）。 |
| `sidebar.html` | side panel 用ページ。 |
| `style.css` | content script 用スタイル。 |
| `jquery-3.1.1.min.js` / `bootstrap.min.*` / `loaders.min.css` | UIライブラリ。 |
| `SKILL.md` | Chrome Web Store 公開用Zipパッケージ作成手順。 |

> 実装は jQuery ベース。content script では `$(document).ready` 後にニコ生プレイヤーのDOM生成をポーリングで待ってから `init()` を実行する。

---

## 機能一覧

### A. 拡張メニュー（視聴ページ・プレイヤー内ボタン）

ニコニコのロゴ風アイコンから開く設定パネル（`#nicoExtArea`）。

1. **コメント透過度調整** … 0〜100％のレンジスライダー（`#commentOpac`）。コメントレイヤの `opacity` を変更。
2. **音量ブースト（配信音声のみ）** … 0〜500％のレンジ（`#haisinVolumeSize`）。Web Audio API の `GainNode` で配信映像の音声のみブースト。ギフト／ニコ生ゲーム音は対象外なので音量バランス調整に使える。
3. **ゲーム・ギフト（エモーション）非表示** … トグル（`#radio-hide-emotion`）。`#akashic-gameview` のエモーションレイヤの表示/非表示を切り替え。
   - 当初仕様「ゲーム・ギフト非表示時に自動でエモーションレイヤを隠す」自動判定ロジックは現状コメントアウト中（手動トグルで動作）。
4. **画面反転** … トグル（`#radio-hanten`）。配信映像 `<video>` を `rotateY(180deg)` で左右反転。

### B. コメント描画拡張（キーボード操作）

1. **コメント透過度調整** … `Ctrl + ↑ / ↓` でコメント透過度を5％単位で変更（`opacity` 変数）。

### C. コメント表示欄拡張（コメントリスト右クリックメニュー）

1. **「URLを開く」**（※調整中） … コメント欄の行を右クリックして表示されるコンテキストメニューに項目を追加。対象コメントから URL を正規表現で検出し、`window.open` で別ウィンドウ表示。

### D. ワイプメニュー（プレイヤー内ボタン `#nicoWipeArea`）

1. **コメントワイプ表示**（`#radio-wipeComment`） … 画面全体のコメントを映像右下に縮小表示（`#comment-layer-container` を `scale(0.3)`）。
2. **ゲームワイプ表示**（`#radio-wipeGame`） … ゲーム・ギフト・エモーション（`#akashic-gameview`）を映像右下に縮小表示。

### E. キャプチャメニュー β（プレイヤー内ボタン `#nicoCaptureArea`、ドラッグ移動可）

1. **配信キャプチャ（動画）**（`#captureVideo`） … `<video>.captureStream()` を `MediaRecorder` で録画し、mp4 として保存。再生状態が変化すると自動停止。
2. **配信キャプチャ（画像）**（`#capturePic`） … 再生中映像をキャプチャして png 保存。`background.js` の `chrome.downloads` 経由でダウンロード。
   - ゲーム画面向けキャプチャ（`#capturePicGame`）は jimp でクロップする実験的処理。

### F. 拡張機能アイコン（popup / side panel）— 番組一覧

ツールバーアイコンから開く一覧。Bootstrap のタブで切り替え（`popup.html` / `popup.js`）。

| タブ | ID | 内容 | 取得元API |
|---|---|---|---|
| お気に入りフォロー（配信中） | `#menu1` `#favoList` | フォロー中の配信中番組 | `front/api/pages/follow/v1/programs?status=onair` |
| フォロー中（配信中・非お気に入り） | `#menu2` `#liveList` | 上記のうちお気に入り除外分 | （`menu1` のキャッシュを利用） |
| 終了済み番組履歴 | `#menu3` `#closedList` | フォロー中の終了済み番組（スクロールで追加読込・フィルタ可） | `...programs?status=closed&offset=N` |
| ちくらん一覧 | `#menu4` `#chikuranList` | ちくわちゃん（外部サイト）のランキング | `chikuwachan.com/live/NCU/` |

- サムネイルはホバーでアニメーション再生（数フレームをポーリング取得しバッファ）。
- お気に入り判定は `localStorage` の `notFavolist`（除外リスト）で管理。
- `background.js` が定期的に通知ボックスAPIを叩き、配信中件数をアイコンバッジに表示。

---

## 実装上の注意点

- **ニコ生のDOMクラス名は難読化＆動的**（例: `___comment-button___OS_ma`）。`[class^="..."]` / `[class*="..."]` の前方一致・部分一致セレクタで対応している。ニコ生側のUI更新でセレクタが壊れやすいため、機能追加・修正時はセレクタの依存箇所を確認すること。
- `init()` 内は `setInterval` でのDOM出現待ちが多用されている。要素取得失敗を前提に防御的に書く。
- **非破壊優先**: 既存のメニュー・トグル・キャプチャ動作を壊さないこと（CLAUDE.md冒頭の実装方針参照）。

---

## バージョン管理・公開

- `manifest.json` の `version`（現在 `0.1.8`）をセマンティックバージョニングで更新。
- 公開用Zip作成手順は [SKILL.md](SKILL.md) を参照。
