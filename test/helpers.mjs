import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// 2026-10-29 抓到的真實頁面，當天沒有任何停班停課訊息
export const NO_ANNOUNCEMENT = fs.readFileSync(path.join(dir, 'fixtures', 'no-announcement.html'), 'utf8');

const NO_MESSAGE_ROW = /<TR><TD headers='city_Name'[^>]*>.*?無停班停課訊息。.*?<\/TD><\/TR>/s;

// 把真實頁面裡「無停班停課訊息」那一列換成指定的列，其餘（標題、日期、備註）維持真實頁面的樣子。
// 有公告時各縣市列的確切寫法我們沒有樣本，所以這裡的列是照該頁面的標記風格與歷史公告的句型「模擬」的
export function pageWith(rowsHtml) {
  if (!NO_MESSAGE_ROW.test(NO_ANNOUNCEMENT)) throw new Error('樣本頁面的格式變了，helpers 要跟著改');
  return NO_ANNOUNCEMENT.replace(NO_MESSAGE_ROW, rowsHtml);
}

export function cityRow(city, statusHtml) {
  return `<TR><TD headers='city_Name' align=center>${city}</TD><TD align=left><FONT color=#FF0000>${statusHtml}</FONT></TD></TR>`;
}

// 三欄的版本（區域、縣市、狀態），以前有一陣子是這樣
export function cityRow3(region, city, statusHtml) {
  return `<TR><TD>${region}</TD><TD>${city}</TD><TD>${statusHtml}</TD></TR>`;
}
