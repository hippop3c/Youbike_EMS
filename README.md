# 智慧維護調度（GitHub Pages 版）

這個版本以手機操作為主，沿用線上 `DISPATCH` 的黃黑視覺、單欄輸入與逐站任務卡流程，並改成維護工單的分區、路徑與完成回報。

![首頁預覽](preview.png)

## 專案檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 隱私安全版，不含內建工單；上線後由使用者上傳 Excel |
| `Code.gs` | 選用的 Google Apps Script 跨裝置同步後端 |
| `.nojekyll` | 告訴 GitHub Pages 直接發佈靜態檔案 |
| `preview.png` | 首頁預覽圖 |

## 直接部署到 GitHub Pages

1. 建立新的 GitHub repository。
2. 把本資料夾中的檔案上傳到 repository 根目錄；首頁檔名必須是 `index.html`。
3. 到 **Settings → Pages**。
4. 在 **Build and deployment** 選擇 **Deploy from a branch**。
5. 選擇 `main` 與 `/(root)`，儲存後等待 GitHub Pages 完成部署。

專案型網址通常會是：

```text
https://你的帳號.github.io/你的Repository名稱/
```

## 發佈前的資料安全提醒

GitHub Pages 網站會公開在網際網路上。本套件的 `index.html` 已移除內建工單，不會把預設車號、場站或維修內容寫入公開前端。使用者需在頁面上傳 Excel 後才會有工單資料。仍請注意：上傳後資料會保存在該瀏覽器的 `localStorage`；若啟用公開的同步後端，也應另行加入身分驗證與權限控制。

## 功能

- 上傳 `派工總表.xlsx`，自動讀取包含「派工總表」字樣的工作表。
- 依區域代號歸入北、東、南、西四大責任區。
- 依目前位置與行車時間預算，規劃可完成最多維修工量的逐站路線。
- 使用 OSRM 計算道路時間，失敗時自動改用直線距離估算。
- 使用 Leaflet／OpenStreetMap 顯示路線，並提供每站 Google 導航。
- 單機模式使用 `localStorage` 與 `BroadcastChannel`；同一裝置的分頁可互通。
- 可選配 `Code.gs`，讓多台裝置同步工單與同區進度。

## Excel 欄位格式

系統從第 4 列開始讀取，使用欄位如下：

| Excel 欄 | 內容 |
|---|---|
| C | 車號 |
| D | 9 碼場站代碼＋場站名稱 |
| E | 車柱 |
| F | 維修原因 |
| G | 來源 |
| H | `緯度,經度` |
| J | 區域代號，例如 `G1`、`A3`、`H2` |

工作表名稱只要包含「派工總表」即可，例如 `2.0派工總表`。

## 跨裝置同步（選用）

1. 到 Google Apps Script 建立獨立專案。
2. 貼上 `Code.gs`。
3. 部署為 **網頁應用程式**：以你本人身分執行，並設定可存取的使用者範圍。
4. 複製結尾為 `/exec` 的網址。
5. 打開 `index.html`，把：

```js
const SYNC_URL='';
```

改成：

```js
const SYNC_URL='https://script.google.com/macros/s/你的部署ID/exec';
```

`Code.gs` 使用 Script Properties 儲存資料，適合輕量測試與內部試行。公開、多人或敏感的正式環境應改用有身分驗證、存取控制與資料庫的後端。前端中的網址無法當作祕密金鑰。

## 本機預覽

直接雙擊也能開啟大部分功能；定位與部分瀏覽器權限建議用本機 HTTP 伺服器測試：

```bash
python -m http.server 8000
```

然後開啟 `http://localhost:8000/`。

## 外部服務

此靜態版需要網路連線以載入 Leaflet、SheetJS、OpenStreetMap 圖磚與 OSRM 路徑服務。若外部服務暫時無法使用，工單清單仍可操作，路徑時間會回退為距離估算，地圖則顯示載入提示。
