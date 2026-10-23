'use strict';
// Аванс хранится по месяцам: { 'YYYY-MM|first': ₸, 'YYYY-MM|second': ₸ }. В новом месяце записи прошлых месяцев удаляются.
function pruneAdvance(map, now = new Date()) {
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const src = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  const out = Object.fromEntries(Object.entries(src).filter(([k]) => k.slice(0, 7) >= cur));
  return { map: out, changed: Object.keys(out).length !== Object.keys(src).length };
}
module.exports = { pruneAdvance };
