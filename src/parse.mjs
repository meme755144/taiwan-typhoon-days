// 解析人事行政總處「天然災害停止上班及上課情形」頁面（https://www.dgpa.gov.tw/typh/daily/nds.html）。
// 只靠標準函式庫、不依賴 HTML 解析套件：頁面是單純的表格，用規則式比對就夠，也比較不會因為套件更新而壞掉。
//
// 這個模組不做任何網路與檔案存取，輸入 HTML 字串、輸出整理好的資料，方便用樣本測試。

export const CITIES = [
  '臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣',
  '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'
];
const CITY_SET = new Set(CITIES);

export function normalizeCity(text) {
  return String(text).replace(/台/g, '臺').replace(/\s+/g, '');
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : m;
  });
}

// 儲存格的純文字：<br> 變成換行，其餘標籤拿掉，連續空白縮成一個
export function cellText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---------- 單一句子 ----------
//
// 頁面上每個縣市的狀態是幾個句子，句型很固定（用 2024～2026 年的公告整理過，一共 24 種）：
//   [範圍:]今天|明天|後天 [上午|中午|下午|晚上] [HH:MM起] 停止上班、停止上課。
//   [範圍:]明天照常上班、停止上課。            （只有學校停課）
//   [範圍:]今天已達停止上班及上課標準。         （已達標準，視同停班停課）
//   [範圍:]今天未達停止上班、已達停止上課標準。
// 「範圍」沒寫就是整個縣市；寫了的是鄉鎮區、村里，或單一學校。

const PERIODS = { 上午: 'morning', 中午: 'noon', 下午: 'afternoon', 晚上: 'evening', 晚間: 'evening' };
const DAY_OFFSET = { 今天: 0, 明天: 1, 後天: 2 };
const SCHOOL_RE = /(學校|學院|大學|國小|國中|高中|高職|高工|中學|小學|幼兒園|幼稚園|托嬰|托兒所|學前|分校|分班|附設|教室|實驗|師範|專校)/;   // 單獨的「園」不算（大園區、新園鄉是地名）

export function scopeKind(scope) {
  if (!scope) return 'city';
  return SCHOOL_RE.test(scope) ? 'school' : 'area';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

// 「上班」「上課」各自是停止還是照常。看不懂回傳 null
function verdictOf(rest) {
  if (/已達停止上班及上課標準/.test(rest)) return { work: true, school: true };
  if (/未達停止上班及上課標準/.test(rest)) return { work: false, school: false };
  const work = /(已達停止|未達停止|停止|照常)上班/.exec(rest);
  const school = /(已達停止|未達停止|停止|照常)上課/.exec(rest);
  if (!work && !school) return null;
  const stops = (m) => m !== null && (m[1] === '停止' || m[1] === '已達停止');
  return { work: stops(work), school: stops(school) };
}

// 解析一個句子。today 是頁面標題的日期（"YYYY-MM-DD"），「今天」「明天」都以它為準。
// 回傳 { item } 或 { unknown } 或 null（完全沒有資訊的句子，例如「尚未宣布消息」）
export function parseSentence(sentence, today) {
  const s = sentence.trim().replace(/[。\s]+$/, '');
  if (!s || /尚未宣布|無停班停課訊息/.test(s)) return null;

  const m = /^(?:(.*?)[:：])?(今天|明天|後天)(上午|中午|下午|晚上|晚間)?(?:(\d{1,2}):(\d{2})起)?(.*)$/.exec(s);
  if (!m) return { unknown: s };
  const [, scopeRaw, dayWord, periodWord, hh, mm, rest] = m;
  const verdict = verdictOf(rest);
  if (!verdict) return { unknown: s };

  const period = periodWord ? PERIODS[periodWord] : '';
  let from = '';
  if (hh !== undefined) {
    let h = parseInt(hh, 10);
    if ((period === 'afternoon' || period === 'evening') && h < 12) h += 12;
    else if (period === 'noon' && h < 11) h += 12;
    from = `${pad2(h)}:${mm}`;
  }

  const date = addDays(today, DAY_OFFSET[dayWord]);
  const scope = (scopeRaw || '').trim();
  const [, month, day] = date.split('-').map(Number);
  return {
    item: {
      date,
      scope,
      scopeKind: scopeKind(scope),
      work: verdict.work,
      school: verdict.school,
      period,
      from,
      // 句子裡的「今天」「明天」換成日期，過了午夜同一筆公告的文字才不會變
      text: s.slice(scopeRaw === undefined ? 0 : s.indexOf(dayWord)).replace(dayWord, `${month}/${day}`) + '。'
    }
  };
}

// ---------- 整個頁面 ----------

function findTable(html) {
  const open = /<table\b[^>]*\bid\s*=\s*["']?Table["']?[^>]*>/i.exec(html);
  if (!open) return null;
  const rest = html.slice(open.index + open[0].length);
  const close = /<\/table>/i.exec(rest);
  return close ? rest.slice(0, close.index) : rest;
}

function pageDateOf(html) {
  const header = /class\s*=\s*["'][^"']*Header_YMD[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (!header) return null;
  const m = /(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(cellText(header[1]));
  if (!m) return null;
  return `${parseInt(m[1], 10) + 1911}-${pad2(m[2])}-${pad2(m[3])}`;   // 民國年
}

function updatedAtOf(html) {
  const m = /更新時間[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(html);
  if (!m) return null;
  return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}T${pad2(m[4])}:${m[5]}:${m[6]}+08:00`;   // 頁面用的是台灣時間
}

// 回傳：
//   ok: false, reason         找不到表格（版面可能改了）
//   ok: true,
//     pageDate, pageUpdatedAt
//     items: [{ city, date, scope, scopeKind, work, school, period, from, text }]   所有看得懂的句子（含「照常」）
//     unknown: [{ city, text }]                                                     看不懂的句子
//     noMessage: 頁面明確寫「無停班停課訊息」
//     leftover: 表格裡有內容但一個縣市也認不出來時，整個表格的文字（給人看）
export function parsePage(html) {
  const table = findTable(html);
  if (table === null) return { ok: false, reason: '找不到 id="Table" 的表格（頁面版面可能改了）' };

  const pageDate = pageDateOf(html);
  const pageUpdatedAt = updatedAtOf(html);
  // 頁面標題的日期是「今天」的基準；讀不到就用更新時間的日期，再不行就沒辦法換算日期
  const today = pageDate || (pageUpdatedAt ? pageUpdatedAt.slice(0, 10) : null);
  if (!today) return { ok: false, reason: '讀不到頁面標題的日期（頁面版面可能改了）' };

  const items = [];
  const unknown = [];
  let cityRows = 0;
  let noMessage = false;
  const otherText = [];

  for (const row of table.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) => cellText(c.replace(/^<t[dh]\b[^>]*>|<\/t[dh]>$/gi, '')));
    if (cells.length === 0 || /^<tr[^>]*class\s*=\s*["']?Table_Head/i.test(row)) continue;

    const at = cells.findIndex((c) => CITY_SET.has(normalizeCity(c)));
    if (at < 0) {
      const text = cells.join(' ');
      if (/無停班停課訊息/.test(text)) noMessage = true;
      else if (!/本總處|語音查詢|勞動部|業務性質特殊/.test(text)) otherText.push(text);   // 表格底下的備註列不算
      continue;
    }

    cityRows++;
    const city = normalizeCity(cells[at]);
    for (const sentence of cells.slice(at + 1).join('\n').split(/[。\n]/)) {
      const parsed = parseSentence(sentence, today);
      if (!parsed) continue;
      if (parsed.item) items.push({ city, ...parsed.item });
      else unknown.push({ city, text: parsed.unknown });
    }
  }

  return {
    ok: true,
    pageDate: today,
    pageUpdatedAt,
    items,
    unknown,
    noMessage,
    leftover: cityRows === 0 && !noMessage && otherText.length > 0 ? otherText.join('\n').slice(0, 2000) : ''
  };
}
