import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, cellText, normalizeCity, parsePage, parseSentence, scopeKind } from '../src/parse.mjs';
import { NO_ANNOUNCEMENT, cityRow, cityRow3, pageWith } from './helpers.mjs';

const TODAY = '2026-10-29';
const item = (s) => parseSentence(s, TODAY).item;

test('真實頁面（沒有公告）：日期、更新時間、無訊息', () => {
  const r = parsePage(NO_ANNOUNCEMENT);
  assert.equal(r.ok, true);
  assert.equal(r.pageDate, '2026-10-29');            // 115年10月29日
  assert.equal(r.pageUpdatedAt, '2026-10-29T10:07:15+08:00');
  assert.equal(r.noMessage, true);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.unknown, []);
  assert.equal(r.leftover, '');                        // 底下的備註列不算「表格裡有別的內容」
});

// 2024～2026 年公告裡出現過的全部 24 種句型
const TEMPLATES = [
  ['今天停止上班、停止上課。', { work: true, school: true, period: '', from: '' }],
  ['今天照常上班、照常上課。', { work: false, school: false, period: '', from: '' }],
  ['今天已達停止上班及上課標準。', { work: true, school: true, period: '', from: '' }],
  ['今天未達停止上班及上課標準。', { work: false, school: false, period: '', from: '' }],
  ['今天照常上班、停止上課。', { work: false, school: true, period: '', from: '' }],
  ['今天未達停止上班、已達停止上課標準。', { work: false, school: true, period: '', from: '' }],
  ['今天下午停止上班、停止上課。', { work: true, school: true, period: 'afternoon', from: '' }],
  ['今天上午停止上班、停止上課。', { work: true, school: true, period: 'morning', from: '' }],
  ['今天晚上停止上班、停止上課。', { work: true, school: true, period: 'evening', from: '' }],
  ['今天下午01:00起停止上班、停止上課。', { work: true, school: true, period: 'afternoon', from: '13:00' }],
  ['今天中午12:00起停止上班、停止上課。', { work: true, school: true, period: 'noon', from: '12:00' }],
  ['今天晚上06:00起停止上班、停止上課。', { work: true, school: true, period: 'evening', from: '18:00' }],
  ['今天上午10:00起停止上班、停止上課。', { work: true, school: true, period: 'morning', from: '10:00' }],
  ['今天晚上06:00起已達停止上班及上課標準。', { work: true, school: true, period: 'evening', from: '18:00' }],
  ['今天上午08:00起已達停止上班及上課標準。', { work: true, school: true, period: 'morning', from: '08:00' }],
  ['今天下午已達停止上班及上課標準。', { work: true, school: true, period: 'afternoon', from: '' }],
  ['今天下午01:00起已達停止上班及上課標準。', { work: true, school: true, period: 'afternoon', from: '13:00' }],
  ['今天下午照常上班、停止上課。', { work: false, school: true, period: 'afternoon', from: '' }],
  ['今天上午11:00起照常上班、停止上課。', { work: false, school: true, period: 'morning', from: '11:00' }],
  ['今天晚上06:00起照常上班、停止上課。', { work: false, school: true, period: 'evening', from: '18:00' }],
  ['今天下午03:00起照常上班、停止上課。', { work: false, school: true, period: 'afternoon', from: '15:00' }],
  ['今天中午12:00起照常上班、停止上課。', { work: false, school: true, period: 'noon', from: '12:00' }],
  ['今天中午12:00起已達停止上班及上課標準。', { work: true, school: true, period: 'noon', from: '12:00' }],
  ['今天下午照常上班、照常上課。', { work: false, school: false, period: 'afternoon', from: '' }]
];

for (const [sentence, expected] of TEMPLATES) {
  test(`句型：${sentence}`, () => {
    const got = item(sentence);
    assert.equal(got.date, TODAY);
    assert.equal(got.scope, '');
    assert.equal(got.scopeKind, 'city');
    assert.deepEqual({ work: got.work, school: got.school, period: got.period, from: got.from }, expected);
  });
}

test('「今天」「明天」「後天」換算成日期，月底跨月也對', () => {
  assert.equal(parseSentence('明天停止上班、停止上課。', TODAY).item.date, '2026-10-30');
  assert.equal(parseSentence('後天停止上班、停止上課。', TODAY).item.date, '2026-10-31');
  assert.equal(parseSentence('明天停止上班、停止上課。', '2026-10-31').item.date, '2026-11-01');
  assert.equal(parseSentence('明天停止上班、停止上課。', '2026-12-31').item.date, '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('句子文字用日期取代「今天」「明天」，過了午夜同一筆公告的文字不會變', () => {
  const tonight = parseSentence('明天停止上班、停止上課。', '2026-10-29').item;
  const tomorrow = parseSentence('今天停止上班、停止上課。', '2026-10-30').item;
  assert.equal(tonight.text, '10/30停止上班、停止上課。');
  assert.deepEqual(tonight, tomorrow);
});

test('範圍：整個縣市、鄉鎮區、學校', () => {
  assert.equal(item('花蓮縣光復鄉:今天停止上班、停止上課。').scope, '花蓮縣光復鄉');
  assert.equal(item('花蓮縣光復鄉:今天停止上班、停止上課。').scopeKind, 'area');
  assert.equal(item('桃源區拉芙蘭里:明天停止上班、停止上課。').scopeKind, 'area');
  assert.equal(item('秀林鄉大天祥地區(含富世村布洛灣及13至19鄰範圍):明天停止上班、停止上課。').scopeKind, 'area');
  assert.equal(item('臺北市湖田實驗國民小學:今天停止上班、停止上課。').scopeKind, 'school');
  assert.equal(item('和平區所轄幼兒園:今天下午01:00起停止上班、停止上課。').scopeKind, 'school');
  assert.equal(item('桃園市復興區三光國民小學附設幼兒園、高義國民小學附設幼兒園:明天照常上班、停止上課。').scopeKind, 'school');
  assert.equal(item('新園鄉:明天停止上班、停止上課。').scopeKind, 'area');   // 地名裡的「園」不是學校
  assert.equal(scopeKind('大園區'), 'area');
  assert.equal(scopeKind(''), 'city');
});

test('範圍用全形冒號、時間的冒號不會被當成範圍', () => {
  assert.equal(item('桃源區：今天停止上班、停止上課。').scope, '桃源區');
  const t = item('今天晚上06:00起停止上班、停止上課。');
  assert.equal(t.scope, '');
  assert.equal(t.from, '18:00');
});

test('沒有資訊的句子回傳 null，看不懂的句子回傳 unknown', () => {
  assert.equal(parseSentence('', TODAY), null);
  assert.equal(parseSentence('尚未宣布消息。', TODAY), null);
  assert.equal(parseSentence('無停班停課訊息。', TODAY), null);
  assert.deepEqual(parseSentence('明天全縣停班停課，請注意安全。', TODAY), { unknown: '明天全縣停班停課，請注意安全' });
  assert.deepEqual(parseSentence('今天全天停課。', TODAY), { unknown: '今天全天停課' });
});

test('縣市名稱：「台」與「臺」視為相同', () => {
  assert.equal(normalizeCity('台北市'), '臺北市');
  assert.equal(normalizeCity(' 台 南 市 '), '臺南市');
});

test('儲存格文字：<br> 換行、標籤與實體處理', () => {
  assert.equal(cellText('<FONT color=#FF0000>今天停止上班&nbsp;、停止上課。</FONT><br>明天照常上班、照常上課。'), '今天停止上班 、停止上課。\n明天照常上班、照常上課。');
  assert.equal(cellText('A&amp;B &#20013;&#x6587;'), 'A&B 中文');
});

test('有公告：兩欄、多句、全縣＋區＋學校', () => {
  const html = pageWith(
    cityRow('臺北市', '今天照常上班、照常上課。<br>明天停止上班、停止上課。') +
    cityRow('花蓮縣', '光復鄉:今天停止上班、停止上課。<br>光復鄉:明天停止上班、停止上課。<br>花蓮縣光復鄉大全國民小學:明天照常上班、停止上課。') +
    cityRow('台南市', '今天下午01:00起停止上班、停止上課。')
  );
  const r = parsePage(html);
  assert.equal(r.ok, true);
  assert.equal(r.noMessage, false);
  assert.equal(r.unknown.length, 0);

  const taipei = r.items.filter((i) => i.city === '臺北市');
  assert.equal(taipei.length, 2);
  assert.deepEqual(taipei.map((i) => [i.date, i.work, i.school]), [['2026-10-29', false, false], ['2026-10-30', true, true]]);

  const hualien = r.items.filter((i) => i.city === '花蓮縣');
  assert.deepEqual(hualien.map((i) => [i.date, i.scopeKind, i.work, i.school]), [
    ['2026-10-29', 'area', true, true],
    ['2026-10-30', 'area', true, true],
    ['2026-10-30', 'school', false, true]
  ]);

  const tainan = r.items.filter((i) => i.city === '臺南市');
  assert.equal(tainan.length, 1);
  assert.equal(tainan[0].from, '13:00');
});

test('有公告：三欄（區域、縣市、狀態）也讀得懂', () => {
  const html = pageWith(cityRow3('北部地區', '基隆市', '今天停止上班、停止上課。') + cityRow3('北部地區', '新北市', '尚未宣布消息'));
  const r = parsePage(html);
  assert.deepEqual(r.items.map((i) => [i.city, i.work]), [['基隆市', true]]);
  assert.equal(r.noMessage, false);
});

test('列出全部縣市、多數「尚未宣布消息」也沒問題', () => {
  const rows = ['臺北市', '新北市', '基隆市'].map((c) => cityRow(c, '尚未宣布消息')).join('');
  const r = parsePage(pageWith(rows));
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, []);
  assert.equal(r.leftover, '');
});

test('看不懂的句子：進 unknown，不會被當成正常', () => {
  const r = parsePage(pageWith(cityRow('高雄市', '明天全市停班停課，請注意安全。')));
  assert.deepEqual(r.unknown, [{ city: '高雄市', text: '明天全市停班停課，請注意安全' }]);
  assert.deepEqual(r.items, []);
});

test('表格裡有內容但一個縣市都認不出來：leftover 保留文字', () => {
  const r = parsePage(pageWith('<TR><TD colspan=2>颱風來襲，高雄市明天停班停課</TD></TR>'));
  assert.equal(r.ok, true);
  assert.equal(r.noMessage, false);
  assert.match(r.leftover, /高雄市明天停班停課/);
});

test('版面大改：找不到表格、讀不到日期都回報失敗，不猜', () => {
  assert.equal(parsePage('<html><body>維護中</body></html>').ok, false);
  assert.equal(parsePage(NO_ANNOUNCEMENT.replace('id="Table"', 'id="Other"')).ok, false);

  const noHeader = NO_ANNOUNCEMENT.replace(/class="Header_YMD"/, 'class="X"');
  const fallback = parsePage(noHeader);   // 標題日期讀不到，退而用「更新時間」的日期
  assert.equal(fallback.ok, true);
  assert.equal(fallback.pageDate, '2026-10-29');

  const neither = noHeader.replace('更新時間', '更新');
  assert.equal(parsePage(neither).ok, false);
});

test('標籤大小寫與引號寫法不同也找得到表格', () => {
  const html = NO_ANNOUNCEMENT.replace('<TABLE id="Table" rules="ALL">', "<table ID='Table'>");
  assert.equal(parsePage(html).ok, true);
});
