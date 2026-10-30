# taiwan-typhoon-days

定時抓取行政院人事行政總處的「[天然災害停止上班及上課情形](https://www.dgpa.gov.tw/typh/daily/nds.html)」，整理成 JSON 放在這個 repo 裡，並累積歷史紀錄。其他程式只要讀這個 repo 的檔案，就不用各自去爬原始網頁。

> **這不是官方資料。** 內容整理自人事總處的公開網頁，可能延遲、遺漏或解析錯誤，實際停班停課以官方公告為準。

## 取得資料

直接讀 raw 網址。請用 `raw.githubusercontent.com`，不要用 jsDelivr，後者對分支檔案會快取很久：

```
https://raw.githubusercontent.com/meme755144/taiwan-typhoon-days/main/data/latest.json
https://raw.githubusercontent.com/meme755144/taiwan-typhoon-days/main/data/history/2026.json
```

## 資料格式

### `data/latest.json`：目前頁面上的狀態

| 欄位 | 說明 |
| --- | --- |
| `schema` | 格式版本，目前是 2 |
| `state` | `none` 沒有停班停課；`announced` 有；`unparsed` 頁面有內容但看不懂 |
| `cities` | 有停班或停課的縣市。key 是縣市名（一律用「臺」），value 是一串項目 |
| `schools` | 單一學校的停課，依縣市分組，項目格式同 `cities`（`scopeKind` 是 `school`）。獨立一欄，不混在 `cities` 裡 |
| `unparsedText` | `state` 是 `unparsed` 且認不出縣市時，頁面表格的文字 |
| `checkedAt` | 最近一次寫檔的時間（UTC）。沒有變化時最多每 6 小時才更新一次，所以超過約 8 小時沒更新，就代表爬蟲可能停了 |
| `pageDate`, `pageUpdatedAt` | 頁面標題的日期、頁面上的「更新時間」（台灣時間，`+08:00`） |
| `error` | 平常是 `null`；被擋或版面改了的時候有內容（見「失敗時的處理」） |

`cities` 裡每個項目：

```json
{ "date": "2026-10-30", "scope": "", "scopeKind": "city", "work": true, "school": true,
  "period": "", "from": "", "text": "10/30停止上班、停止上課。" }
```

| 欄位 | 說明 |
| --- | --- |
| `date` | 這筆公告適用的日期（頁面上的「今天」「明天」已換算成日期） |
| `scope`, `scopeKind` | `scope` 空的是整個縣市（`city`）；有寫的是鄉鎮區、村里（`area`）。單一學校（`school`）放在 `schools`，不在 `cities` 裡 |
| `work`, `school` | 是否停止上班、停止上課 |
| `period`, `from` | 半天或從幾點開始，例如 `afternoon`、`13:00`；全天則是空字串 |

看不懂的句子會變成 `{ "unknown": true, "text": "…" }`，內容保留原文。**讀取資料的程式要把它當成「有公告，請自行查看」**，不能當成沒事。

### `data/history/{年}.json`：歷史紀錄

每個「日期＋縣市＋範圍」一筆，欄位同上，另有 `firstSeen`（第一次看到的時間）和 `updatedAt`（內容最後一次改變）。公告被撤銷時不刪除，改成 `work`、`school` 都是 `false`。縣市、鄉鎮區、單一學校都會記（用 `scopeKind` 區分）。依 2024–2026 年的歷史公告估算，一年大約 240～630 筆、85～225 KB（颱風多的年份較大），十年大約 1～2 MB；依年分檔，單一檔案不會太大。

> 歷史紀錄從 **2026-10-29** 開始累積，更早的補不回來；爬蟲沒在跑的時段，錯過的公告也記不到。

## 運作方式

### 抓取頻率

依據頁面下方寫明的發布時限，在最可能公告的時段加密（台灣時間）：

| 時段 | 為什麼 | 頻率 |
| --- | --- | --- |
| 18:00–23:59 | 全日或上午停班課，前一晚 19:00–22:00 前發布 | 每 10 分鐘 |
| 04:00–05:59 | 前一天沒發、當天風雨變強，4:30 前發布 | 每 10 分鐘 |
| 09:00–11:59 | 下午或晚間停班課，10:30 前發布 | 每 10 分鐘 |
| 其他時間 | 其他時間也可能隨時發布 | 每 30 分鐘 |

GitHub Actions 的排程不準時，常延遲 5～30 分鐘，高負載時還會直接跳過，所以這是「盡量」，不是保證。排程設定在 [`.github/workflows/scrape.yml`](.github/workflows/scrape.yml)。

實測（2026-10-29 起）：這個 repo 的排程大約只跑了設定次數的一成，而且沒有規律，最長連續 7 個多小時完全沒跑。所以除了 GitHub 自己的排程，另外加了「外部觸發」當並行的備援，見下一節。

### 外部觸發（備援）

用一個外部的定時服務（例如 [cron-job.org](https://cron-job.org)）定時呼叫 GitHub 的 API，叫 `scrape` 工作流程跑一次。它和 GitHub 自己的排程**並行**：

- 兩邊同時觸發也沒關係。`scrape.yml` 裡的 `concurrency` 讓同一時間只會跑一個，其餘最多排一個等待，多的會被取消（Actions 列表上顯示 `cancelled`，不是失敗，也不會寄通知信）。
- 後跑的那次通常頁面沒變，只回 304，不會寫檔、不會 commit。
- 外部服務壞了或 token 過期時，GitHub 自己的排程還在，只是回到比較不穩的狀態。

設定步驟（外部服務的介面可能改版，重點是下面這幾個值）：

1. 在 GitHub 建一個 **fine-grained personal access token**：Settings → Developer settings → Personal access tokens → Fine-grained tokens。
   - Repository access 選 **Only select repositories**，只選這個 repo。
   - Permissions → Repository permissions → **Actions: Read and write**，其餘都不給。
   - 期限自己決定，**不要用預設的 30 天**（過期後觸發會全部失敗，而且不會自己好）。個人帳號可以選「不過期」（組織或企業的政策可能禁止）。取捨：不過期不會突然停擺，但 token 外洩後會一直有效，直到你自己撤銷；設期限（例如 1 年）外洩時有自動止損點，但要記得到期前換新，忘了就停擺。這個 token 只有這個 repo 的 Actions 讀寫權限，外洩最糟是別人能一直觸發爬蟲，不能改程式；所以兩種都合理，容易忘記換的人選不過期比較實際。設了期限就在自己的行事曆記下到期前的提醒。
   - token 只會顯示一次，貼到外部服務之後不要留在別的地方，也不要放進 repo。
2. 在外部服務建一個定時工作：
   - 網址：`https://api.github.com/repos/<帳號>/<repo>/actions/workflows/scrape.yml/dispatches`
   - 方法：`POST`，內容（body）：`{"ref":"main"}`
   - 標頭：`Authorization: Bearer <token>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: typhoon-days-trigger`（GitHub 的 API 一定要有 `User-Agent`）、`Content-Type: application/json`
   - 頻率：最簡單是全天每 10 分鐘。頁面沒更新時只回 304，負擔很小；想完全對齊上面的表格，就在 18:00–23:59、04:00–05:59、09:00–11:59（台灣時間）每 10 分鐘，其餘時間每 30 分鐘。注意外部服務的時區設定。
   - **開啟失敗通知**（請求失敗或回應不是 204 時寄信給你）。
3. 先在外部服務按「立即執行」，到 Actions 分頁應該會出現一筆 `workflow_dispatch`；成功時 API 回應是 `204`，沒有內容。
4. 隔一兩天回來看：Actions 列表有沒有穩定每 10 分鐘出現 `workflow_dispatch`，以及 `data/latest.json` 的 `checkedAt` 有沒有持續更新（沒變化時最多每 6 小時才會寫一次，所以看 `checkedAt` 要看這個間隔）。

### 寫入頻率（commit）

「抓取」和「寫入」是兩件事：

| | 頻率 | 做什麼 |
| --- | --- | --- |
| 抓取（Actions 執行） | 依上表，每 10 分鐘或每 30 分鐘 | 連到人事總處的頁面，讀取並比對 |
| 寫入（commit） | **資料有變就立刻寫；沒有變化時，最多每 6 小時才寫一次** | 更新 `data/` 並 push 到 repo |

- 抓到的內容跟上次一樣，就不寫檔、不 commit。所以沒有颱風的日子，repo 大約每 6 小時才有一筆 commit，這筆只更新 `checkedAt`（「心跳」，證明爬蟲還活著）。實際間隔是 6 到 6.5 小時，因為要等下一次執行才會寫。
- 公告出現、改變或被撤銷時，不用等 6 小時，那一次執行就會立刻 commit。
- 所以 commit 紀錄**不能**拿來看「爬蟲多久跑一次」；要看實際跑了幾次，請到 GitHub 的 Actions 分頁。
- 6 小時是 [`src/merge.mjs`](src/merge.mjs) 裡的 `HEARTBEAT_MS`，想改就改那個值。

### 失敗時的處理

| 情況 | 怎麼處理 |
| --- | --- |
| 網路不通、逾時、伺服器 5xx | 不寫檔，也不算失敗（免得停機時一直寄通知信）。`checkedAt` 停在最後一次寫檔的時間 |
| 被擋（403／429） | 保留上次的資料，寫入 `error`（`status`、`message`、`since`、`lastAt`、`count`、`backoffUntil`）。這次執行標成失敗，GitHub 會寄通知信給你 |
| 版面改了（找不到表格、讀不到日期） | 同上，不會覆蓋舊資料 |
| 有內容但看不懂 | 不當成錯誤，`state` 是 `unparsed`，原文放在 `unparsedText` 或 `cities` 的 `unknown` 項目裡 |

恢復正常後的下一次寫檔，會把 `error` 清成 `null`。

### 對來源網站的禮貌

- 一次只抓一個頁面（約 15 KB），帶上次的 `ETag`／`Last-Modified`，沒更新時只回 304。
- 使用者代理字串寫明專案網址，不偽裝成瀏覽器。
- 被擋時暫停 30 分鐘，之後每次加倍，最多 6 小時；暫停期間完全不連線。
- 逾時 20 秒，最多重試 2 次。

> **注意：** 人事總處網站的 `robots.txt` 寫的是 `User-agent: *` 全部 `Disallow: /`（只放行 Googlebot）。這個專案抓的就是那個頁面，所以公開、散布或大量使用之前，請自己評估。

## 解析的依據與限制

- 句子的格式是用 2024–2026 年的歷次公告整理出來的，一共 24 種句型（例如「明天停止上班、停止上課。」「今天下午01:00起停止上班、停止上課。」「今天已達停止上班及上課標準。」），[`test/parse.test.mjs`](test/parse.test.mjs) 全部都有測。「已達標準」視同停班停課。
- 沒有公告時，真實頁面只有一列「無停班停課訊息。」，已用實際抓到的頁面測過。**有公告時各縣市列的確切 HTML 沒有樣本**，目前是依表格結構（縣市在一格、狀態在另一格，也支援多一欄區域的寫法）與歷史句型推測的。第一次真的有颱風公告時請檢查輸出；解析不了時會走 `unparsed`，不會漏報。
- 範圍的分類（縣市、鄉鎮區、單一學校）是靠名稱判斷：名稱裡有「國小、國中、高中、幼兒園、學校、托兒所」等字的算學校，其餘有寫範圍的算鄉鎮區。判斷錯的話，歷史紀錄裡仍保留原始的 `scope` 文字，可以事後重新分類。
- 一個句子如果列了多所學校（例如「某某國小附設幼兒園、某某國小附設幼兒園」），會存成一筆，`scope` 是整串名稱。

## 開發

需要 Node.js 20 以上，不需要安裝任何套件。

```
node --test                          # 測試（不連網，用假網站與樣本頁面）
node src/scrape.mjs                  # 實際抓一次，寫進 data/
DATA_DIR=/tmp/x node src/scrape.mjs  # 寫到別的資料夾
```

## 部署

1. 建立一個**公開**的 GitHub repo，把這個資料夾 push 上去，預設分支用 `main`。公開 repo 的 Actions 分鐘數不限；私有的每月只有 2000 分鐘，這樣的頻率會超過。
2. Settings → Actions → General → Workflow permissions 維持預設的「Read repository contents and packages permissions」就好，不用改。工作流程裡已經宣告了 `contents: write`，會蓋過這個預設值。只有當機器人 push 因為權限被擋（例如被組織政策限制）時，才需要改成「Read and write permissions」。
3. 到 Actions 分頁 → `scrape` → Run workflow，手動跑一次，看輸出與 `data/latest.json`。這一步可以確認 GitHub 的主機連得上人事總處的網站；被擋的話，這次會失敗，並在 `latest.json` 寫入 `error`。
4. 之後會依排程自動跑，但 GitHub 的排程不穩，建議照上面「外部觸發（備援）」再設一組並行的。公開 repo 若 60 天沒有任何活動，GitHub 可能停用排程；本專案至少每 6 小時會有一次 commit，應該不會發生。如果發現 `checkedAt` 很久沒更新，先到 Actions 分頁看排程是否被停用。
