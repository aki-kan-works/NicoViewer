// NicoViewer service worker (MV3)
// - content script からのメッセージ処理（画像ダウンロード / 可視タブのキャプチャ）
// - 配信中件数を拡張機能アイコンのバッジに表示

// ツールバーアイコンクリックでサイドパネルを開けるようにする
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// content script からのメッセージ処理
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  switch (request.method) {
    // 画像（PNG等）をダウンロード保存する
    case 'download': {
      // ファイル名に使えない文字をアンダースコアへ置換
      const filename = request.filename.replace(/[(\\/:\*?\"<>\)]/g, "_");
      chrome.downloads.download({
        url: request.data,
        filename: filename,
      });
      break;
    }

    // 現在表示中のタブを画像としてキャプチャし、data URL を返す
    case 'capture':
      captureVisibleTab().then((url) => sendResponse(url));
      return true; // sendResponse を非同期で呼ぶため true を返す
  }
});

// 可視タブを PNG でキャプチャして data URL を返す
function captureVisibleTab() {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(
      chrome.windows.WINDOW_ID_CURRENT,
      { format: "png" },
      (url) => resolve(url)
    );
  });
}

// 配信中件数をバッジに表示（初回 + 20秒ごと）
getLiveCount();
setInterval(getLiveCount, 20000);

function getLiveCount() {
  fetch('https://papi.live.nicovideo.jp/api/relive/notifybox.content?rows=100')
    .then((response) => response.json())
    .then(function (res) {
      const list = res.data ? res.data.notifybox_content : [];
      chrome.action.setBadgeText({ text: list.length > 0 ? String(list.length) : '' });
    });
}
