// 端到端：起一個假的網站（回傳樣本頁面），真的跑 run()，檢查寫出來的檔案與各種失敗情況
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run, decodeBody } from '../src/scrape.mjs';
import { NO_ANNOUNCEMENT, cityRow, pageWith } from './helpers.mjs';

const ALERT = pageWith(
  cityRow('臺北市', '今天照常上班、照常上課。<br>明天停止上班、停止上課。') +
  cityRow('花蓮縣', '光復鄉:明天停止上班、停止上課。<br>花蓮縣光復鄉大全國民小學:明天照常上班、停止上課。')
);
const REVOKED = pageWith(cityRow('臺北市', '今天照常上班、照常上課。<br>明天照常上班、照常上課。') + cityRow('花蓮縣', '光復鄉:明天停止上班、停止上課。'));
const T0 = new Date('2026-10-29T12:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const HOUR = 3600 * 1000;

// 假網站：mode 決定回傳什麼
function startServer() {
  const state = { status: 200, body: NO_ANNOUNCEMENT, etag: null, hits: 0, lastHeaders: null };
  const server = http.createServer((req, res) => {
    state.hits++;
    state.lastHeaders = req.headers;
    if (state.etag && req.headers['if-none-match'] === state.etag && state.status === 200) {
      res.writeHead(304, { ETag: state.etag });
      res.end();
      return;
    }
    const headers = { 'Content-Type': 'text/html; charset=UTF-8' };
    if (state.etag) headers.ETag = state.etag;
    res.writeHead(state.status, headers);
    res.end(state.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, server, url: `http://127.0.0.1:${server.address().port}/nds.html` })));
}

const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const exists = (dir, name) => fs.existsSync(path.join(dir, name));

test('完整流程：無公告 → 304 → 公告 → 內容不變 → 心跳 → 撤銷', async () => {
  const { state, server, url } = await startServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typhoon-'));
  const go = (now) => run({ url, dataDir, now, retryDelaysMs: [0, 0] });
  try {
    // 1. 平常日：寫出 latest.json，沒有歷史
    state.etag = '"v1"';
    let r = await go(T0);
    assert.equal(r.action, 'written');
    let latest = read(dataDir, 'latest.json');
    assert.equal(latest.state, 'none');
    assert.equal(latest.pageDate, '2026-10-29');
    assert.equal(latest.checkedAt, T0.toISOString());
    assert.equal(latest.validators.etag, '"v1"');
    assert.equal(exists(dataDir, 'history/2026.json'), false);

    // 2. 頁面沒變：帶 If-None-Match，回 304，不寫檔
    r = await go(at(HOUR));
    assert.equal(r.action, 'unchanged');
    assert.equal(state.lastHeaders['if-none-match'], '"v1"');
    assert.match(state.lastHeaders['user-agent'], /^TaiwanTyphoonDays\/1\.0/);
    assert.equal(read(dataDir, 'latest.json').checkedAt, T0.toISOString());

    // 3. 出現公告
    state.etag = '"v2"';
    state.body = ALERT;
    r = await go(at(2 * HOUR));
    assert.equal(r.action, 'written');
    latest = read(dataDir, 'latest.json');
    assert.equal(latest.state, 'announced');
    assert.deepEqual(Object.keys(latest.cities), ['臺北市', '花蓮縣'].sort());
    assert.equal(latest.cities['臺北市'].length, 1);
    assert.equal(latest.cities['臺北市'][0].date, '2026-10-30');
    assert.equal(latest.schema, 2);
    assert.deepEqual(Object.keys(latest.schools), ['花蓮縣']);
    assert.equal(latest.schools['花蓮縣'][0].scope, '花蓮縣光復鄉大全國民小學');
    const history = read(dataDir, 'history/2026.json');
    assert.equal(history.records.length, 3);                       // 臺北市、花蓮縣光復鄉、大全國小
    assert.deepEqual(history.records.map((x) => x.scopeKind).sort(), ['area', 'city', 'school']);

    // 4. 頁面重新產生（ETag 變了）但內容一樣：不寫檔
    state.etag = '"v3"';
    const before = fs.statSync(path.join(dataDir, 'latest.json')).mtimeMs;
    r = await go(at(3 * HOUR));
    assert.equal(r.action, 'unchanged');
    assert.equal(fs.statSync(path.join(dataDir, 'latest.json')).mtimeMs, before);

    // 5. 超過心跳時間：內容沒變也更新 checkedAt
    r = await go(at(2 * HOUR + 6 * HOUR));
    assert.equal(r.action, 'written');
    assert.equal(read(dataDir, 'latest.json').checkedAt, at(8 * HOUR).toISOString());
    assert.equal(read(dataDir, 'history/2026.json').records.length, 3);   // 歷史沒有被重複寫入

    // 6. 臺北市撤銷停班停課：latest 不再有臺北市，歷史保留並改成 false
    state.etag = '"v4"';
    state.body = REVOKED;
    r = await go(at(9 * HOUR));
    assert.equal(r.action, 'written');
    assert.deepEqual(Object.keys(read(dataDir, 'latest.json').cities), ['花蓮縣']);
    const rec = read(dataDir, 'history/2026.json').records.find((x) => x.city === '臺北市');
    assert.equal(rec.work, false);
    assert.equal(rec.school, false);
  } finally {
    server.close();
  }
});

test('舊格式（schema 1）的 latest.json：不帶 ETag 重抓，頁面沒變也升級成新格式', async () => {
  const { state, server, url } = await startServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typhoon-'));
  const go = (now) => run({ url, dataDir, now, retryDelaysMs: [0, 0] });
  try {
    state.etag = '"v1"';
    await go(T0);
    const file = path.join(dataDir, 'latest.json');
    fs.writeFileSync(file, JSON.stringify({ ...read(dataDir, 'latest.json'), schema: 1 }));

    // 只過 1 小時、頁面沒變：以前會回 304 然後什麼都不寫
    const r = await go(at(HOUR));
    assert.equal(r.action, 'written');
    assert.equal(state.lastHeaders['if-none-match'], undefined);
    assert.equal(read(dataDir, 'latest.json').schema, 2);

    // 升級之後恢復正常：帶 ETag、回 304、不寫檔
    assert.equal((await go(at(2 * HOUR))).action, 'unchanged');
    assert.equal(state.lastHeaders['if-none-match'], '"v1"');
  } finally {
    server.close();
  }
});

test('被擋（403）：保留舊資料、記錄錯誤、暫停期間不再連線、逐次加倍、恢復後清掉錯誤', async () => {
  const { state, server, url } = await startServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typhoon-'));
  const go = (now) => run({ url, dataDir, now, retryDelaysMs: [0, 0] });
  try {
    state.body = ALERT;
    await go(T0);

    state.status = 403;
    let r = await go(at(HOUR));
    assert.equal(r.action, 'blocked');
    assert.equal(r.exitCode, 1);                                   // 第一次要讓執行失敗，GitHub 才會寄通知
    let latest = read(dataDir, 'latest.json');
    assert.equal(latest.state, 'announced');                       // 舊資料還在
    assert.equal(latest.error.status, 403);
    assert.equal(latest.error.count, 1);
    assert.equal(latest.error.backoffUntil, at(HOUR + 30 * 60000).toISOString());

    const hits = state.hits;
    r = await go(at(HOUR + 10 * 60000));
    assert.equal(r.action, 'skipped');
    assert.equal(r.exitCode, 0);
    assert.equal(state.hits, hits);                                // 暫停期間完全沒有連線

    r = await go(at(HOUR + 31 * 60000));                           // 暫停結束，再試仍被擋：暫停加倍
    assert.equal(r.action, 'blocked');
    latest = read(dataDir, 'latest.json');
    assert.equal(latest.error.count, 2);
    assert.equal(latest.error.since, at(HOUR).toISOString());
    assert.equal(Date.parse(latest.error.backoffUntil) - at(HOUR + 31 * 60000).getTime(), 60 * 60000);

    state.status = 200;                                            // 恢復
    r = await go(at(3 * HOUR));
    assert.equal(r.action, 'written');
    assert.equal(read(dataDir, 'latest.json').error, null);
  } finally {
    server.close();
  }
});

test('版面改了：不覆蓋舊資料、回報錯誤；伺服器錯誤或連不上：不寫檔也不算失敗', async () => {
  const { state, server, url } = await startServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typhoon-'));
  const go = (now) => run({ url, dataDir, now, retryDelaysMs: [0, 0] });
  try {
    state.body = ALERT;
    await go(T0);
    const good = fs.readFileSync(path.join(dataDir, 'latest.json'), 'utf8');

    state.body = '<html><body>系統維護中</body></html>';
    let r = await go(at(HOUR));
    assert.equal(r.action, 'layout-changed');
    assert.equal(r.exitCode, 1);
    const latest = read(dataDir, 'latest.json');
    assert.equal(latest.state, 'announced');
    assert.match(latest.error.message, /版面/);

    // 回到正常之後錯誤清掉
    state.body = ALERT;
    r = await go(at(3 * HOUR));
    assert.equal(r.action, 'written');
    assert.equal(read(dataDir, 'latest.json').error, null);
    assert.equal(read(dataDir, 'latest.json').cities['臺北市'].length, 1);

    // 伺服器 500：重試後放棄，不寫檔，不讓執行失敗
    const stable = fs.readFileSync(path.join(dataDir, 'latest.json'), 'utf8');
    state.status = 500;
    const hits = state.hits;
    r = await go(at(4 * HOUR));
    assert.equal(r.action, 'unreachable');
    assert.equal(r.exitCode, 0);
    assert.equal(state.hits - hits, 3);                            // 第一次 + 重試 2 次
    assert.equal(fs.readFileSync(path.join(dataDir, 'latest.json'), 'utf8'), stable);
    assert.notEqual(stable, good);
  } finally {
    server.close();
  }

  // 連不上（伺服器已關閉）
  const r = await run({ url, dataDir, now: at(5 * HOUR), retryDelaysMs: [0, 0] });
  assert.equal(r.action, 'unreachable');
  assert.equal(r.exitCode, 0);
});

test('認不得有公告時的版面：state=unparsed，保留原文，不會當成沒事', async () => {
  const { state, server, url } = await startServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typhoon-'));
  try {
    state.body = pageWith('<TR><TD colspan=2>颱風來襲，高雄市明天停班停課</TD></TR>');
    const r = await run({ url, dataDir, now: T0, retryDelaysMs: [0] });
    assert.equal(r.action, 'written');
    const latest = read(dataDir, 'latest.json');
    assert.equal(latest.state, 'unparsed');
    assert.match(latest.unparsedText, /高雄市明天停班停課/);
  } finally {
    server.close();
  }
});

test('壞掉的 latest.json 不會被默默蓋掉', async () => {
  const { server, url } = await startServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typhoon-'));
  try {
    fs.writeFileSync(path.join(dataDir, 'latest.json'), '{ not json');
    await assert.rejects(() => run({ url, dataDir, now: T0, retryDelaysMs: [0] }));
    assert.equal(fs.readFileSync(path.join(dataDir, 'latest.json'), 'utf8'), '{ not json');
  } finally {
    server.close();
  }
});

test('編碼：依標頭或 <meta> 解碼，不認得的編碼退回 UTF-8', () => {
  const utf8 = new TextEncoder().encode('<meta charset="utf-8">臺北市').buffer;
  assert.equal(decodeBody(utf8, 'text/html; charset=UTF-8'), '<meta charset="utf-8">臺北市');
  assert.equal(decodeBody(utf8, 'text/html'), '<meta charset="utf-8">臺北市');
  assert.equal(decodeBody(utf8, 'text/html; charset=x-no-such-charset'), '<meta charset="utf-8">臺北市');
  // Big5 的「台北市」：A5 78 A5 5F A5 AB
  const big5 = new Uint8Array([0xa5, 0x78, 0xa5, 0x5f, 0xa5, 0xab]).buffer;
  assert.equal(decodeBody(big5, 'text/html; charset=big5'), '台北市');
});
