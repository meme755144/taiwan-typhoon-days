import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_MS, backoffFor, buildLatest, contentOf, inBackoff, mergeHistory, shouldWrite, withError } from '../src/merge.mjs';

const NOW = new Date('2026-10-29T14:00:00Z');
const HOUR = 3600 * 1000;

const mk = (over) => ({
  city: '臺北市', date: '2026-10-30', scope: '', scopeKind: 'city', work: true, school: true, period: '', from: '',
  text: '10/30停止上班、停止上課。', ...over
});
const parsedOf = (items, extra = {}) => ({ items, unknown: [], leftover: '', pageDate: '2026-10-29', pageUpdatedAt: '2026-10-29T22:00:00+08:00', ...extra });

test('contentOf：沒有任何停班停課 → none', () => {
  const c = contentOf(parsedOf([mk({ work: false, school: false })]));
  assert.equal(c.state, 'none');
  assert.deepEqual(c.cities, {});
});

test('contentOf：縣市與範圍（區）列入，學校只算數量', () => {
  const c = contentOf(parsedOf([
    mk(),
    mk({ city: '花蓮縣', scope: '光復鄉', scopeKind: 'area', text: '10/30停止上班、停止上課。' }),
    mk({ city: '花蓮縣', scope: '花蓮縣光復鄉大全國民小學', scopeKind: 'school', work: false }),
    mk({ city: '花蓮縣', scope: '花蓮縣光復鄉富源國民小學', scopeKind: 'school', work: false })
  ]));
  assert.equal(c.state, 'announced');
  assert.deepEqual(Object.keys(c.cities), ['臺北市', '花蓮縣']);   // 依字碼排序，順序固定即可
  assert.equal(c.cities['花蓮縣'].length, 1);
  assert.deepEqual(c.schools, { 花蓮縣: 2 });
});

test('contentOf：只有學校停課不算 announced', () => {
  const c = contentOf(parsedOf([mk({ scope: '某國小', scopeKind: 'school', work: false })]));
  assert.equal(c.state, 'none');
  assert.deepEqual(c.schools, { 臺北市: 1 });
});

test('contentOf：看不懂的句子與無法辨認的內容 → unparsed；有看得懂的停班停課時仍是 announced', () => {
  const unknownOnly = contentOf(parsedOf([], { unknown: [{ city: '高雄市', text: '明天全市停班停課' }] }));
  assert.equal(unknownOnly.state, 'unparsed');
  assert.deepEqual(unknownOnly.cities['高雄市'], [{ unknown: true, text: '明天全市停班停課' }]);

  assert.equal(contentOf(parsedOf([], { leftover: '颱風來襲' })).state, 'unparsed');

  const both = contentOf(parsedOf([mk()], { unknown: [{ city: '高雄市', text: '怪句子' }] }));
  assert.equal(both.state, 'announced');
});

test('contentOf：順序固定，輸入順序不同結果也一樣（不會產生多餘的 diff）', () => {
  const a = contentOf(parsedOf([mk({ city: '臺北市' }), mk({ city: '基隆市' }), mk({ date: '2026-10-29', text: 'x' })]));
  const b = contentOf(parsedOf([mk({ date: '2026-10-29', text: 'x' }), mk({ city: '基隆市' }), mk({ city: '臺北市' })]));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('shouldWrite：第一次、內容變了、錯誤恢復、心跳到期才寫', () => {
  const content = contentOf(parsedOf([mk()]));
  const prev = buildLatest({ content, parsed: parsedOf([mk()]), source: 's', validators: {}, now: NOW });

  assert.equal(shouldWrite(null, content, NOW), true);
  assert.equal(shouldWrite(prev, content, new Date(NOW.getTime() + HOUR)), false);
  assert.equal(shouldWrite(prev, content, new Date(NOW.getTime() + HEARTBEAT_MS - 1)), false);
  assert.equal(shouldWrite(prev, content, new Date(NOW.getTime() + HEARTBEAT_MS)), true);

  const changed = contentOf(parsedOf([mk(), mk({ city: '基隆市' })]));
  assert.equal(shouldWrite(prev, changed, NOW), true);

  const errored = withError(prev, { status: 403, message: 'x', backoffMs: HOUR, now: NOW });
  assert.equal(shouldWrite(errored, content, NOW), true);
});

test('shouldWrite：頁面更新時間、頁面日期變了但內容沒變，不算變化', () => {
  const content = contentOf(parsedOf([]));
  const prev = buildLatest({ content, parsed: parsedOf([]), source: 's', validators: {}, now: NOW });
  assert.equal(shouldWrite(prev, contentOf(parsedOf([], { pageDate: '2026-10-30' })), new Date(NOW.getTime() + HOUR)), false);
});

test('withError：保留舊資料、累計次數、第一次發生的時間不變', () => {
  const content = contentOf(parsedOf([mk()]));
  const prev = buildLatest({ content, parsed: parsedOf([mk()]), source: 's', validators: { etag: 'e' }, now: NOW });
  const e1 = withError(prev, { status: 403, message: '被擋', backoffMs: 30 * 60000, now: NOW });
  assert.equal(e1.state, 'announced');                         // 舊資料還在
  assert.equal(e1.error.count, 1);
  assert.equal(e1.error.backoffUntil, '2026-10-29T14:30:00.000Z');
  const later = new Date(NOW.getTime() + HOUR);
  const e2 = withError(e1, { status: 403, message: '被擋', backoffMs: HOUR, now: later });
  assert.equal(e2.error.count, 2);
  assert.equal(e2.error.since, NOW.toISOString());
  assert.equal(e2.error.lastAt, later.toISOString());
  assert.equal(withError(null, { status: 200, message: 'm', backoffMs: 0, now: NOW }).error.backoffUntil, null);
});

test('暫停：30 分鐘、1、2、4 小時，最多 6 小時', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map((n) => backoffFor(n) / 60000), [30, 60, 120, 240, 360, 360, 360]);
  const prev = withError(null, { status: 429, message: 'm', backoffMs: 30 * 60000, now: NOW });
  assert.equal(inBackoff(prev, new Date(NOW.getTime() + 29 * 60000)), true);
  assert.equal(inBackoff(prev, new Date(NOW.getTime() + 30 * 60000)), false);
  assert.equal(inBackoff(null, NOW), false);
  assert.equal(inBackoff(buildLatest({ content: contentOf(parsedOf([])), parsed: parsedOf([]), source: 's', now: NOW }), NOW), false);
});

test('歷史：新增、第一次看到的時間保留、內容沒變就不動', () => {
  const t1 = new Date('2026-10-29T12:00:00Z'), t2 = new Date('2026-10-29T13:00:00Z'), t3 = new Date('2026-10-29T14:00:00Z');
  const first = mergeHistory([], [mk()], t1);
  assert.equal(first.records.length, 1);
  assert.deepEqual([...first.changedYears], ['2026']);
  assert.equal(first.records[0].firstSeen, t1.toISOString());

  const same = mergeHistory(first.records, [mk()], t2);
  assert.equal(same.changedYears.size, 0);
  assert.equal(same.records[0].updatedAt, t1.toISOString());

  const changed = mergeHistory(first.records, [mk({ period: 'afternoon', from: '13:00', text: '10/30下午01:00起停止上班、停止上課。' })], t3);
  assert.deepEqual([...changed.changedYears], ['2026']);
  assert.equal(changed.records[0].firstSeen, t1.toISOString());
  assert.equal(changed.records[0].updatedAt, t3.toISOString());
  assert.equal(changed.records[0].from, '13:00');
});

test('歷史：從來沒停過的不記；單一學校不逐筆記；撤銷時改成都是 false 而不是刪除', () => {
  const t1 = new Date('2026-10-29T12:00:00Z'), t2 = new Date('2026-10-29T13:00:00Z');
  assert.equal(mergeHistory([], [mk({ work: false, school: false })], t1).records.length, 0);
  assert.equal(mergeHistory([], [mk({ scope: '某國小', scopeKind: 'school' })], t1).records.length, 0);

  const stop = mergeHistory([], [mk()], t1).records;
  const revoked = mergeHistory(stop, [mk({ work: false, school: false, text: '10/30照常上班、照常上課。' })], t2);
  assert.equal(revoked.records.length, 1);
  assert.equal(revoked.records[0].work, false);
  assert.equal(revoked.records[0].firstSeen, t1.toISOString());
  assert.equal(revoked.records[0].updatedAt, t2.toISOString());
});

test('歷史：頁面不再列出的舊紀錄保留，排序固定，跨年依日期分年', () => {
  const t1 = new Date('2026-12-31T12:00:00Z');
  const old = mergeHistory([], [mk({ date: '2026-12-31', text: 'a' }), mk({ city: '基隆市', date: '2026-12-31', text: 'b' })], t1).records;
  const next = mergeHistory(old, [mk({ date: '2027-01-01', text: 'c' })], t1);
  assert.equal(next.records.length, 3);
  assert.deepEqual([...next.changedYears], ['2027']);
  assert.deepEqual(next.records.map((r) => r.date), ['2026-12-31', '2026-12-31', '2027-01-01']);
});
