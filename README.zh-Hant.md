# Memfolio

[![License](https://img.shields.io/github/license/howar31/memfolio?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/howar31/memfolio?style=flat-square)](https://github.com/howar31/memfolio/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/howar31/memfolio/ci.yml?style=flat-square&label=CI)](https://github.com/howar31/memfolio/actions/workflows/ci.yml)
[![Browsers](https://img.shields.io/badge/browsers-Chrome%20%7C%20Edge%20%7C%20Firefox-blue?style=flat-square)](https://memfolio.howar31.com)
[![Downloads](https://img.shields.io/github/downloads/howar31/memfolio/total?style=flat-square)](https://github.com/howar31/memfolio/releases)
[![Sponsor](https://img.shields.io/badge/%E8%B4%8A%E5%8A%A9-donate.howar31.com-b4532c?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTIwLjg0IDQuNjFhNS41IDUuNSAwIDAgMC03Ljc4IDBMMTIgNS42N2wtMS4wNi0xLjA2YTUuNSA1LjUgMCAwIDAtNy43OCA3Ljc4bDEuMDYgMS4wNkwxMiAyMS4yM2w3Ljc4LTcuNzggMS4wNi0xLjA2YTUuNSA1LjUgMCAwIDAgMC03Ljc4eiIvPjwvc3ZnPg==)](https://donate.howar31.com/)

[English](README.md) | 正體中文

把社群平台上的相片與影片存進電腦資料夾的瀏覽器擴充功能，資料夾裡已經有的檔案不會重複下載。適用於 Instagram。官方網站：[memfolio.howar31.com](https://memfolio.howar31.com)

## 功能

- 在個人檔案頁按 **下載全部**，依目前所在分頁（貼文、Reels、被標註）下載。
  - 一般執行會在列到第一個已全部存在的頁面時停止。
  - 在 Reels 與被標註分頁，第一次執行會列出每一頁；之後的執行同樣會提前停止。
  - **完整掃描** 會列出每一頁並補上缺少的檔案。
  - 執行中可以取消，下次執行會從缺少檔案的地方接續。
- 單項下載：一則貼文、輪播中的一張、縮圖、Reel、限時動態與精選。快捷鍵：`Ctrl/Cmd + Shift + D`。
  - 檔案存到瀏覽器的下載資料夾。可在設定中改為存到帳號資料夾（限已管理的帳號），已存在的檔案會略過。
- 每個帳號一個資料夾。帳號以數字 id 識別，改名後仍使用原本的資料夾。
  - 第一次下載的帳號，會在預設位置裡建立以帳號名稱命名的資料夾。預設位置只需選擇一次，popup 的設定會顯示它並可更換。更換不會搬移檔案，已在清單上的帳號維持原本的資料夾。
  - 新帳號的面板另有 **下載到其他資料夾…**，可以把該帳號存到自行選擇的資料夾。
- **匯入既有資料夾** 可以從磁碟上已有的檔案重建帳號清單。
- 點工具列圖示會列出管理中的帳號，點一列可開啟該個人檔案頁。
  - 帳號可以放進自訂的群組（群組可收合），也可以釘選到最上方的置頂區塊。群組名稱不可重複。
  - 清單可依名稱、上次執行、檔案數或加入時間排序，排序只在各群組內進行；也可以用按鈕或拖拉手動排序。拖拉還能把帳號移到另一個群組，或調整群組的順序。
  - 清單上的托盤箭頭按鈕會開啟有兩個分頁的畫面。**加入** 可貼上個人頁網址（每行一個），把這些帳號加入清單，過程不會連線到網站。各帳號的資料夾在第一次下載時設定。
  - **匯出** 會依手動排序的順序列出所有帳號的網址，每個群組前有一行 `# 名稱`，可複製或存成文字檔。貼回這段文字會把帳號加入同名的群組，並保留順序作為手動排序。
- 介面語言：英文與正體中文。預設跟隨瀏覽器的語言，也可以在 popup 的設定中指定。
- 時間以 24 小時制顯示，可在設定中改為 12 小時制。
- 個人檔案頁右下角的按鈕可展開與收合面板。收合時訊息會先收起，按鈕上以圓點提示有訊息，可在設定中關閉圓點。面板展開時，**清除訊息** 可一次移除所有訊息。

不傳送任何分析資料或錯誤回報，不載入遠端程式碼。只要求 `storage` 權限，只在 `www.instagram.com` 執行。

## 檔案名稱

```
<username>_<unix time>_<media id>_<account id>.<ext>
```

資料夾裡只要有相同 `<media id>_<account id>` 的檔案，就視為已下載，不論它的帳號名稱、時間或副檔名。

## 需求

Chrome、Edge 或其他 Chromium 瀏覽器，111 版以上。資料夾功能使用 File System Access API，Firefox 與 Safari 沒有提供。Firefox 128 版以上使用另一個建置，資料夾功能較少，見 [Firefox](#firefox)。

Windows 上的資料夾連結：目錄符號連結（`mklink /D`）可以在資料夾選擇視窗中直接選取，行為與它指向的資料夾相同。Junction（`mklink /J`）不行：瀏覽器會把它顯示成空資料夾。瀏覽器不會列出已選資料夾內部的連結；帳號資料夾在那裡開不了也建不了時，擴充功能會請你選擇，此時可以選符號連結或實體資料夾。

開發者模式（在 popup 的設定中，預設關閉）會多出「檢查資料夾」：顯示瀏覽器對所選資料夾回報的內容，並可將結果匯出為 JSON。

## Firefox

Firefox 不讓擴充功能存取磁碟上的資料夾。這是瀏覽器的限制，Firefox 版在這個限制內運作：可以下載單一項目與整個帳號，檔案的管理由你自行處理。

- 檔案存在瀏覽器的下載資料夾內：`<下載資料夾>/Memfolio/<username>/`。`Memfolio` 這個名稱可在 popup 的設定中修改，也可以留空。
- 擴充功能看不到資料夾裡有什麼。每次 **下載全部** 之前會請你選擇該帳號的資料夾。瀏覽器會稱之為「上傳」，實際提供的是資料夾內的檔案清單，只用來判斷哪些檔案已經存在。檔案仍留在你的電腦上。
- 同一個對話框中的 **全部下載** 不做任何檢查：全部下載，同名檔案直接覆寫。
- 單項下載不會與資料夾比對，同名檔案直接覆寫。
- 不提供：匯入既有資料夾、為帳號選擇其他資料夾、檢查資料夾。

Firefox 版除了 `storage` 之外，還要求 `downloads` 權限。

## 安裝

Chromium 瀏覽器與 Firefox 的封裝建置在 [Releases](https://github.com/howar31/memfolio/releases) 頁面；[官方網站](https://memfolio.howar31.com)上有安裝按鈕。

Chrome 或 Edge：解壓縮 zip，開啟 `chrome://extensions`（或 `edge://extensions`），啟用開發人員模式，選「載入未封裝項目」並選擇解壓後的資料夾。Firefox：下載 `.xpi` 檔，在 Firefox 中開啟它（拖進 Firefox 視窗，或用「檔案 > 開啟檔案」）並確認安裝；檔案已由 Mozilla 簽署。

## 建置

```
npm install
npm run build            # 未封裝的擴充功能在 dist/
npm run build:firefox    # Firefox 用的未封裝擴充功能在 dist-firefox/
```

載入方式：開啟 `chrome://extensions`（或 `edge://extensions`），啟用開發人員模式，選「載入未封裝項目」並選擇 `dist` 資料夾。Firefox：開啟 `about:debugging`，選「此 Firefox」，再選「載入暫用附加元件」並選擇 `dist-firefox/manifest.json`。

## 開發

```
npm test             # 單元測試
npm run test:e2e     # 以建置後的擴充功能在 Chrome 中對模擬平台執行
npm run check        # 型別檢查、單元測試、正式建置（兩個）
```

`npm run test:e2e` 需要先安裝一次測試用瀏覽器：`npx puppeteer browsers install chrome`。

每次推送與 pull request 都會執行檢查與瀏覽器測試。推送與 `package.json` 版本相同的 tag `vX.Y.Z`，會建置套件、建立 GitHub release 並把該版本送交各商店。

## 支援

問題回報與功能建議請到 [GitHub Issues](https://github.com/howar31/memfolio/issues/new/choose)。

如果 Memfolio 對你有幫助，歡迎贊助開發：[贊助](https://donate.howar31.com/) · [Ko-fi](https://ko-fi.com/howar31)

## 授權

[Apache-2.0](LICENSE) © 2026 Howar31
