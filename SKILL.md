# SKILL: Chrome拡張機能の公開用Zipパッケージ作成

## 概要

Chrome拡張機能をChrome Web Storeへ公開・更新するための配布パッケージ（Zipファイル）を作成する手順。

---

## 手順

### 1. バージョン番号の確認

`manifest.json` の `version` フィールドを確認する。

```json
{
  "version": "x.y.z"
}
```

### 2. Zipファイルの作成

プロジェクトフォルダごと圧縮し、**一つ上の階層**に以下の命名規則で配置する。

**ファイル名形式:**

```
{拡張機能名}-{バージョン番号}.zip
```

**例:** `NicoMultiViewer-0.1.0.zip`

**PowerShellコマンド:**

```powershell
Compress-Archive -Path "C:\dev\chrome_extension\NicoMultiViewer" `
                 -DestinationPath "C:\dev\chrome_extension\NicoMultiViewer-{バージョン番号}.zip" `
                 -Force
```

`-Force` を付けることで、同名ファイルが既に存在する場合は上書きする。

---

## Chrome Web Store へのアップロード

1. [Chrome Web Store デベロッパーダッシュボード](https://chrome.google.com/webstore/devconsole/) にアクセス
2. 対象の拡張機能を選択（新規公開の場合は「新しいアイテムを追加」）
3. 作成したZipファイルをアップロード
4. ストアの掲載情報（説明文・スクリーンショット等）を確認・更新
5. 審査に提出

---

## 注意事項

- Zipに含めるべきでないファイル（`.git/`, `.claude/`, `node_modules/` 等）がある場合は、`.gitignore` や除外オプションで対処すること。
- バージョン番号を上げた場合は `manifest.json` の `version` を先に更新してからZipを作成すること。
- `manifest.json` の `version` はセマンティックバージョニング（`major.minor.patch`）に従うこと。
