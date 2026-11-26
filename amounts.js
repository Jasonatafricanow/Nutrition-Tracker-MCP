/**
 * Amounts as people say them ("500g", "一斤", "两盒", "半个"), only as far as subtraction is safe: weight and
 * volume convert (斤 = 500g, kg, L); counted things subtract only in the same word (盒 from 盒). Anything else
 * ("一把", "适量", "少许") is not a number here — the caller says it is unknown instead of guessing.
 */
const DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const MASS = { g: 1, 克: 1, kg: 1000, 千克: 1000, 公斤: 1000, 斤: 500, 两: 50 };
const VOLUME = { ml: 1, 毫升: 1, l: 1000, 升: 1000 };
const COUNT = ['个', '只', '根', '盒', '袋', '包', '瓶', '颗', '块', '条', '片', '罐', '枚', '把', '棵', '头', '瓣', '支', '听', '桶', '盘', '碗', '份', '朵', '串'];

function chineseNumber(s) {
  if (s === '半') return 0.5;
  if (/^[零〇一二两俩三四五六七八九]$/.test(s)) return DIGIT[s];
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? DIGIT[m[1]] : 1) * 10 + (m[2] ? DIGIT[m[2]] : 0);
  return null;
}

/** {n, base:'g'|'ml'|<count word>, word} or null. A leading "约/大概" is fine; a range or "几" is not a number. */
export function parseAmount(raw) {
  const s = String(raw ?? '').trim().replace(/^(约|大约|大概|差不多)/, '').replace(/\s+/g, '').toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?|[零〇一二两俩三四五六七八九十半]+)(个半|斤半)?(kg|g|ml|l|千克|公斤|克|斤|两|毫升|升|个|只|根|盒|袋|包|瓶|颗|块|条|片|罐|枚|把|棵|头|瓣|支|听|桶|盘|碗|份|朵|串)?(半)?$/);
  if (!m) return null;
  let n = /^\d/.test(m[1]) ? Number(m[1]) : chineseNumber(m[1]);
  if (n == null || !Number.isFinite(n)) return null;
  let word = m[3] ?? (m[2] ? m[2][0] : null);
  if (m[2] || m[4]) n += 0.5;
  if (!word) return null; // a bare number says nothing about what it counts
  if (word === '两' && m[1] === '两') return null; // "两" alone is ambiguous
  if (Object.hasOwn(MASS, word)) return { n: n * MASS[word], base: 'g', word };
  if (Object.hasOwn(VOLUME, word)) return { n: n * VOLUME[word], base: 'ml', word };
  if (COUNT.includes(word)) return { n, base: word, word };
  return null;
}

const round = n => Math.round(n * 100) / 100;
/** The amount left, written in the unit the pantry used; null when it cannot be subtracted. */
export function subtract(have, used) {
  const a = parseAmount(have), b = parseAmount(used);
  if (!a || !b || a.base !== b.base) return null;
  const left = a.n - b.n;
  if (left <= 1e-9) return { left: 0, text: '' };
  // Same word on both sides keeps it (1斤 − 半斤 = 0.5斤); mixed words fall back to g / ml (1斤 − 300g = 200g).
  if (a.word === b.word || (a.base !== 'g' && a.base !== 'ml')) {
    const per = a.base === 'g' ? MASS[a.word] : a.base === 'ml' ? VOLUME[a.word] : 1;
    return { left, text: `${round(left / per)}${a.word}` };
  }
  return { left, text: `${round(left)}${a.base}` };
}
