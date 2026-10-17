# 亞特的冒險：燼野之境 — v1.0.0

## 部署
將本目錄所有檔案上傳到同一個 GitHub Pages 專案目錄（不要只上傳 index.html）。保持相對路徑不變。GitHub Pages 的 HTTPS 會允許 Service Worker 執行。

## 修改檔案
- `index.html`：網頁 DOM
- `style.css`：樣式（含更新提示）
- `game.js`：原遊戲 JavaScript，未更動遊戲邏輯
- `pwa-update.js`：註冊 SW、偵測新版本、更新提示
- `sw.js`：快取和離線載入
- `manifest.webmanifest`：PWA 安裝資訊

## 後續發布更新（v1.0.1 等）
1. 修改需要的檔案。
2. **務必修改 `sw.js` 最前面的 VERSION**（如改成 `1.0.1`），讓瀏覽器辨識新版並產生新的快取。
3. 更新 `index.html` 的 `application-version` 以便追蹤。
4. 部署全部修改到 GitHub Pages。
5. 開啟已安裝的 PWA 並保持連線；新檔案快取完成後會顯示更新提示。按「立即更新」會重載當局遊戲，請先結束冒險。

## 注意
- 首次需在有網路時成功載入及完成快取，之後主要單人遊戲可離線啟動。多人 PeerJS 連線仍需網路。
- 網頁快取不等於關卡存檔；目前沒有新增進度持久化功能。
- 不要直接用 `file://` 開啟測試 Service Worker；請部署到 HTTPS 或用 localhost。
- iOS 可能因儲存空間政策清除網站快取，因此保留源碼備份。
