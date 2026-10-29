// 把解析結果整理成要存的檔案內容，並決定「這次要不要寫檔」。
// 同樣沒有任何網路與檔案存取，方便測試。
//
// 原則：資料沒變就不寫、不 commit，所以抓得再頻繁，repo 也不會長出一堆沒有意義的 commit。

export const SCHEMA = 1;
export const HEARTBEAT_MS = 6 * 60 * 60 * 1000;   // 就算沒有變化，每隔這段時間也寫一次 checkedAt，讓讀取資料的人看得出資料還新
export const KEEP_SCHOOL_LEVEL = false;           // 單一學校的停課（常見於山區學校）不逐筆存，只記每個縣市有幾所

const isStop = (item) => item.work || item.school;

// 這次頁面的「內容」：用來判斷跟上次有沒有不同（不含檢查時間、頁面更新時間這類每次都會變的欄位）
export function contentOf(parsed) {
  const cities = {};
  const schools = {};
  for (const item of parsed.items) {
    if (!isStop(item)) continue;
    if (item.scopeKind === 'school') {
      schools[item.city] = (schools[item.city] || 0) + 1;
      continue;
    }
    (cities[item.city] = cities[item.city] || []).push(publicItem(item));
  }
  for (const u of parsed.unknown) {
    (cities[u.city] = cities[u.city] || []).push({ unknown: true, text: u.text });
  }

  const sortedCities = {};
  for (const city of Object.keys(cities).sort()) {
    sortedCities[city] = cities[city].sort((a, b) => key(a).localeCompare(key(b)));
  }
  const sortedSchools = {};
  for (const city of Object.keys(schools).sort()) sortedSchools[city] = schools[city];

  const hasStop = Object.values(sortedCities).some((list) => list.some((i) => !i.unknown));
  let state = 'none';
  if (hasStop) state = 'announced';
  else if (Object.keys(sortedCities).length > 0 || parsed.leftover) state = 'unparsed';

  return { state, cities: sortedCities, schools: sortedSchools, unparsedText: parsed.leftover || '' };
}

function publicItem({ date, scope, scopeKind, work, school, period, from, text }) {
  return { date, scope, scopeKind, work, school, period, from, text };
}

const key = (i) => [i.date || '', i.scope || '', i.text || ''].join('|');

export function sameContent(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 寫檔的條件：內容變了、上次是錯誤狀態現在恢復了、或離上次寫檔已超過心跳間隔
export function shouldWrite(prev, content, now) {
  if (!prev) return true;
  if (prev.error) return true;
  if (!sameContent(contentOfLatest(prev), content)) return true;
  const last = Date.parse(prev.checkedAt || '');
  return !Number.isFinite(last) || now.getTime() - last >= HEARTBEAT_MS;
}

function contentOfLatest(latest) {
  return { state: latest.state, cities: latest.cities, schools: latest.schools, unparsedText: latest.unparsedText || '' };
}

export function buildLatest({ content, parsed, source, validators, now }) {
  return {
    schema: SCHEMA,
    source,
    checkedAt: now.toISOString(),
    pageDate: parsed.pageDate,
    pageUpdatedAt: parsed.pageUpdatedAt,
    ...content,
    validators: validators || {},
    error: null
  };
}

// 記錄一個錯誤：保留上次成功抓到的資料，只加上 error，讀取資料的人才知道目前這份資料可能過期
export function withError(prev, { status, message, backoffMs, now }) {
  const base = prev || { schema: SCHEMA, state: 'none', cities: {}, schools: {}, unparsedText: '' };
  const previousError = base.error || null;
  const count = previousError ? previousError.count + 1 : 1;
  return {
    ...base,
    error: {
      since: previousError ? previousError.since : now.toISOString(),
      lastAt: now.toISOString(),
      status,
      message,
      count,
      backoffUntil: backoffMs ? new Date(now.getTime() + backoffMs).toISOString() : null
    }
  };
}

// 被擋（403／429）之後暫停多久：第一次 30 分鐘，之後每次加倍，最多 6 小時
export function backoffFor(previousCount) {
  return Math.min(30 * 60 * 1000 * 2 ** Math.max(0, previousCount), 6 * 60 * 60 * 1000);
}

export function inBackoff(prev, now) {
  if (!prev || !prev.error || !prev.error.backoffUntil) return false;
  return now.getTime() < Date.parse(prev.error.backoffUntil);
}

// ---------- 歷史紀錄 ----------
// data/history/{年}.json：每個「日期＋縣市＋範圍」一筆。第一次看到的時間保留，內容有變才更新 updatedAt。
// 公告被撤銷（例如原本停止、後來改回照常）時，不刪除，而是把那筆改成 work/school 都是 false。

const recordKey = (r) => [r.date, r.city, r.scope].join('|');

export function mergeHistory(existing, items, now) {
  const records = new Map(existing.map((r) => [recordKey(r), r]));
  const stamp = now.toISOString();
  const changedYears = new Set();

  for (const item of items) {
    if (item.scopeKind === 'school' && !KEEP_SCHOOL_LEVEL) continue;
    const k = recordKey(item);
    const old = records.get(k);
    if (!old && !isStop(item)) continue;   // 從來沒停過、現在也沒停：不用記

    const next = {
      date: item.date,
      city: item.city,
      scope: item.scope,
      scopeKind: item.scopeKind,
      work: item.work,
      school: item.school,
      period: item.period,
      from: item.from,
      text: item.text,
      firstSeen: old ? old.firstSeen : stamp,
      updatedAt: stamp
    };
    if (old) {
      const { firstSeen, updatedAt, ...oldBody } = old;
      const { firstSeen: f2, updatedAt: u2, ...newBody } = next;
      if (JSON.stringify(oldBody) === JSON.stringify(newBody)) continue;
    }
    records.set(k, next);
    changedYears.add(item.date.slice(0, 4));
  }

  const list = [...records.values()].sort((a, b) => recordKey(a).localeCompare(recordKey(b)));
  return { records: list, changedYears };
}
