// 抓一次人事行政總處的停班停課頁面，整理後寫進 data/。由 GitHub Actions 定時執行，也可以在本機手動跑：
//   node src/scrape.mjs
// 環境變數（測試用）：TYPHOON_URL 換成別的網址、DATA_DIR 換成別的資料夾。
//
// 對來源網站的禮貌：
//   - 使用者代理字串寫明專案網址，不偽裝成瀏覽器
//   - 帶上上次的 ETag／Last-Modified（頁面沒更新就只回 304）
//   - 被擋（403／429）時暫停一段時間再試，逐次加倍，最多 6 小時
//   - 逾時 20 秒，最多重試 2 次；失敗不會蓋掉舊資料

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePage } from './parse.mjs';
import { backoffFor, buildLatest, contentOf, inBackoff, mergeHistory, shouldWrite, withError } from './merge.mjs';

export const SOURCE = 'https://www.dgpa.gov.tw/typh/daily/nds.html';
const here = path.dirname(fileURLToPath(import.meta.url));

function userAgent() {
  const repo = process.env.GITHUB_REPOSITORY;
  return `TaiwanTyphoonDays/1.0 (+https://github.com/${repo || 'meme755144/taiwan-typhoon-days'}; low-frequency poll of one public page)`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;   // 檔案壞掉要讓人知道，不要默默當作沒有資料然後蓋掉
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 目前頁面是 UTF-8；以前是 Big5，萬一改回去也不會變成亂碼：依標頭或 <meta> 宣告的編碼解碼
export function decodeBody(buffer, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (!charset) charset = /charset=["']?([\w-]+)/i.exec(Buffer.from(buffer.slice(0, 2048)).toString('latin1'));
  try {
    return new TextDecoder(charset ? charset[1] : 'utf-8').decode(buffer);
  } catch (err) {
    return new TextDecoder('utf-8').decode(buffer);   // 不認得的編碼名稱
  }
}

// 抓頁面。回傳 { status, html, validators }；網路錯誤丟例外
async function fetchPage(url, validators, retryDelaysMs) {
  const headers = { 'User-Agent': userAgent(), Accept: 'text/html' };
  if (validators && validators.etag) headers['If-None-Match'] = validators.etag;
  if (validators && validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;

  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        lastError.status = res.status;
        continue;
      }
      const html = res.status === 200 ? decodeBody(await res.arrayBuffer(), res.headers.get('content-type')) : '';
      return {
        status: res.status,
        html,
        validators: { etag: res.headers.get('etag') || '', lastModified: res.headers.get('last-modified') || '' }
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// 執行一次。回傳 { action, exitCode, message }，方便測試；實際執行時由 main() 印出來
export async function run({
  url = process.env.TYPHOON_URL || SOURCE,
  dataDir = process.env.DATA_DIR || path.join(here, '..', 'data'),
  now = new Date(),
  retryDelaysMs = [5000, 15000]
} = {}) {
  const latestFile = path.join(dataDir, 'latest.json');
  const prev = readJson(latestFile, null);

  if (inBackoff(prev, now)) {
    return { action: 'skipped', exitCode: 0, message: `暫停中，到 ${prev.error.backoffUntil} 才會再試（${prev.error.message}）` };
  }

  let page;
  try {
    page = await fetchPage(url, prev && prev.validators, retryDelaysMs);
  } catch (err) {
    // 網路不通、逾時、伺服器錯誤：不寫檔，也不讓這次執行「失敗」（失敗會寄通知信）。
    // 讀取資料的人看 checkedAt 就知道資料多久沒更新
    return { action: 'unreachable', exitCode: 0, message: `抓不到頁面：${err.message}` };
  }

  if (page.status === 403 || page.status === 429) {
    const message = `來源網站拒絕連線（HTTP ${page.status}），可能是被擋了`;
    const backoffMs = backoffFor(prev && prev.error ? prev.error.count : 0);
    writeJson(latestFile, withError(prev, { status: page.status, message, backoffMs, now }));
    // 第一次發生才讓這次執行失敗（寄通知信給你）；之後在暫停期間不會再跑到這裡
    return { action: 'blocked', exitCode: 1, message };
  }

  if (page.status === 304) {
    // 頁面沒變：只需要確認要不要寫心跳
    if (prev && !prev.error && !shouldWrite(prev, { state: prev.state, cities: prev.cities, schools: prev.schools, unparsedText: prev.unparsedText || '' }, now)) {
      return { action: 'unchanged', exitCode: 0, message: '頁面沒有更新（304）' };
    }
    if (prev) {
      writeJson(latestFile, { ...prev, checkedAt: now.toISOString(), error: null });
      return { action: 'heartbeat', exitCode: 0, message: '頁面沒有更新，只更新檢查時間' };
    }
  }

  if (page.status !== 200) {
    return { action: 'unexpected-status', exitCode: 0, message: `預期外的回應：HTTP ${page.status}` };
  }

  const parsed = parsePage(page.html);
  if (!parsed.ok) {
    const message = parsed.reason;
    const backoffMs = backoffFor(prev && prev.error ? prev.error.count : 0);
    writeJson(latestFile, withError(prev, { status: 200, message, backoffMs, now }));
    return { action: 'layout-changed', exitCode: 1, message };
  }

  const content = contentOf(parsed);
  const history = updateHistory(dataDir, parsed, now);

  if (!shouldWrite(prev, content, now)) {
    // 內容沒變、也還沒到心跳時間；歷史若有更新（理論上內容沒變就不會）也已經寫了
    return { action: history ? 'history-only' : 'unchanged', exitCode: 0, message: '內容沒有變化' };
  }

  writeJson(latestFile, buildLatest({ content, parsed, source: url, validators: page.validators, now }));
  return { action: 'written', exitCode: 0, message: `state=${content.state}，縣市 ${Object.keys(content.cities).length} 個` };
}

// 歷史紀錄：依日期的年份分檔。回傳有沒有寫過檔
function updateHistory(dataDir, parsed, now) {
  const years = new Set(parsed.items.map((i) => i.date.slice(0, 4)));
  if (years.size === 0) return false;

  const existing = [];
  for (const year of years) {
    const file = path.join(dataDir, 'history', `${year}.json`);
    existing.push(...readJson(file, { records: [] }).records);
  }
  const { records, changedYears } = mergeHistory(existing, parsed.items, now);
  for (const year of changedYears) {
    writeJson(path.join(dataDir, 'history', `${year}.json`), { schema: 1, records: records.filter((r) => r.date.startsWith(year)) });
  }
  return changedYears.size > 0;
}

async function main() {
  const result = await run();
  const line = `[${result.action}] ${result.message}`;
  if (result.exitCode !== 0) console.error(`::error::${line}`);
  else if (result.action === 'unreachable' || result.action === 'unexpected-status') console.log(`::warning::${line}`);
  else console.log(line);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err.stack || err}`);
    process.exitCode = 1;
  });
}
