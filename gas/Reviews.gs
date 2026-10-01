// ═══════════════════════════════════════════════════════
// HEEBEE REVIEW HUB — Reviews.gs  (v3)
// ═══════════════════════════════════════════════════════
// Replaces: the top part of Code.gs (everything ABOVE "SLACK INTEGRATION
// (Phase D)") and the API LAYER at the bottom. The Slack / Zomato /
// Rejections / Ops-pipeline code in Code.gs stays exactly as it is and keeps
// using SS, getConfig(), fetchAllReviews() and clearReviewsCache() from here.
//
// What changed vs v2:
//   • Only the last N days of reviews are loaded (Config: REVIEW_WINDOW_DAYS,
//     default 15). Google stops paging once it passes the cutoff; the form and
//     Reviews sheets read only their newest rows.
//   • One cache layer instead of two, rebuilt by keepAliveJob every 5 min.
//   • Every source reports ok / count / error, and the app shows it — no more
//     silent empty lists when Google auth expires.
//   • Read / note / reply state works for Google + QR-form reviews too
//     (stored in the "Review_State" sheet).
//   • Session secret lives in Script Properties (not in source code).
//   • Passwords in the Users sheet are hashed on first login.
// ═══════════════════════════════════════════════════════

const SHEET_ID = '1vbtIJU-HkGWPLWSzG6vFRkNS2c5g82Ke-E-40sBlTl4';
const SS       = SpreadsheetApp.openById(SHEET_ID);

const DEFAULT_WINDOW_DAYS = 15;
const SESSION_DAYS        = 30;
const DAY_MS              = 86400000;
const BRANCHES            = ['b1', 'b2', 'b3'];

// ══════════════════════════════════════════════════════
// CONFIG  (memoised per execution — the sheet is read once)
// ══════════════════════════════════════════════════════
let _configMemo = null;

function getAllConfig() {
  if (_configMemo) return _configMemo;
  const sheet = SS.getSheetByName('Config');
  const data  = sheet.getDataRange().getValues();
  const config = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) config[String(data[i][0]).trim()] = data[i][1];
  }
  _configMemo = config;
  return config;
}

function getConfig(key) {
  const v = getAllConfig()[key];
  return (v === undefined || v === '') ? null : v;
}

function windowDays_() {
  const v = Number(getConfig('REVIEW_WINDOW_DAYS'));
  return v > 0 && v <= 365 ? v : DEFAULT_WINDOW_DAYS;
}

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function getInitials(name) {
  if (!name) return '??';
  const str = String(name).trim();
  if (!str) return '??';
  return str.split(' ').map(n => n[0] || '').join('').slice(0, 2).toUpperCase();
}

function getPlatformColor(platform) {
  const colors = { google:'#4285F4', zomato:'#E23744', swiggy:'#FC8019', heebee:'#8B5E3C' };
  return colors[platform] || '#999';
}

function getSentiment(rating) {
  if (rating >= 4) return 'positive';
  if (rating === 3) return 'neutral';
  return 'negative';
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  return Utilities.formatDate(dt, 'Asia/Kolkata', 'd MMM yyyy');
}

function toTs_(d) {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return isNaN(t) ? 0 : t;
}

function mapFormBranch(branchName) {
  if (!branchName) return 'b1';
  const n = branchName.toLowerCase();
  if (n.includes('sarabha'))  return 'b1';
  if (n.includes('ghumar'))   return 'b2';
  if (n.includes('model'))    return 'b3';
  return 'b1';
}

function parseRating(val) {
  if (val === null || val === undefined || val === '') return 3;
  const n = Number(val);
  if (!isNaN(n) && n >= 1 && n <= 5) return Math.round(n);
  const map = { 'loved it': 5, 'satisfactory': 4, 'average': 3, 'not satisfactory': 2 };
  return map[String(val).toLowerCase().trim()] || 3;
}

function convertGMBRating(star) {
  return { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 }[star] || 3;
}

// Reads only the newest `maxRows` data rows of a sheet (header excluded).
// Returns { rows, firstRow } where firstRow is the sheet row number of rows[0].
function readTail_(sheet, maxRows, numCols) {
  const last = sheet.getLastRow();
  if (last < 2) return { rows: [], firstRow: 2 };
  const firstRow = Math.max(2, last - maxRows + 1);
  const cols = numCols || sheet.getLastColumn();
  return { rows: sheet.getRange(firstRow, 1, last - firstRow + 1, cols).getValues(), firstRow: firstRow };
}

// ══════════════════════════════════════════════════════
// SOURCE 1 — Reviews sheet (Zomato email ingest + manual Zomato/Swiggy)
// Columns: ID | Platform | Branch | Reviewer | Rating | Date | Text |
//          Sentiment | Status | Read | ReplyText | Note
// ══════════════════════════════════════════════════════
function readSheetReviews_(cutoff) {
  const sheet = SS.getSheetByName('Reviews');
  const { rows } = readTail_(sheet, 2000, 12);
  const out = [];
  rows.forEach(row => {
    if (!row[0]) return;
    const ts = toTs_(row[5]);
    if (ts < cutoff) return;
    const rating = Number(row[4]) || 0;
    out.push({
      id: String(row[0]), platform: String(row[1] || '').toLowerCase(), branch: String(row[2] || ''),
      reviewer: String(row[3] || 'Anonymous'), rating: rating,
      ts: ts, date: formatDate(row[5]), text: String(row[6] || ''),
      sentiment: row[7] || getSentiment(rating), status: row[8] || 'pending',
      read: row[9] === true || String(row[9]).toUpperCase() === 'TRUE',
      replyText: String(row[10] || ''), note: String(row[11] || '')
    });
  });
  return out;
}

// ══════════════════════════════════════════════════════
// SOURCE 2 — Heebee QR feedback form (separate spreadsheet)
// IDs stay 'form_<rowIndex>_<timestamp>' so Slack's Seen_Reviews still match.
// ══════════════════════════════════════════════════════
function readFormReviews_(cutoff) {
  const formId = getConfig('FORM_SHEET_ID');
  if (!formId) throw new Error('FORM_SHEET_ID missing in Config sheet');

  const sheet = SpreadsheetApp.openById(formId).getSheets()[0];
  const { rows, firstRow } = readTail_(sheet, 1500, 14);
  const out = [];

  rows.forEach((row, j) => {
    if (!row[0]) return;
    const ts = toTs_(row[0]);
    if (ts < cutoff) return;
    const i = firstRow - 1 + j;               // same index the old full read used

    const email       = String(row[1]  || '').trim();
    const name        = String(row[2]  || 'Anonymous').trim();
    const phone       = String(row[3]  || '').trim();
    const instagram   = String(row[5]  || '').trim();
    const branch      = mapFormBranch(String(row[6] || '').trim());
    const order       = String(row[7]  || '').trim();
    const expRating   = row[10];
    const staffRating = row[11];
    const feedback    = String(row[12] || '').trim();
    const suggestion  = String(row[13] || '').trim();

    const unrated = expRating === '' || expRating === null || expRating === undefined;
    const rating  = unrated ? 3 : parseRating(expRating);

    let text = feedback;
    if (suggestion.length > 1) text += (text ? ' · Suggestion: ' : 'Suggestion: ') + suggestion;
    if (order.length > 1)      text += (text ? '\n\n' : '') + 'Ordered: ' + order;
    if (String(staffRating).trim() !== '') text += (text ? '\n' : '') + 'Staff rating: ' + staffRating + '/5';
    if (unrated) text = (text ? text + '\n\n' : '') + '⚠️ No rating provided';
    if (!text) text = 'No written feedback provided.';

    out.push({
      id: 'form_' + i + '_' + ts, platform: 'heebee', branch: branch,
      reviewer: name, phone: phone, email: email, instagram: instagram,
      rating: rating, unrated: unrated, ts: ts, date: formatDate(row[0]),
      text: text, sentiment: unrated ? 'neutral' : getSentiment(rating),
      status: 'unread', read: false, replyText: '', note: ''
    });
  });
  return out;
}

// ══════════════════════════════════════════════════════
// SOURCE 3 — Google Business Profile (OAuth2 library)
// ══════════════════════════════════════════════════════
function getGMBService() {
  return OAuth2.createService('GMB')
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/auth')
    .setTokenUrl('https://accounts.google.com/o/oauth2/token')
    .setClientId(getConfig('GMB_CLIENT_ID'))
    .setClientSecret(getConfig('GMB_CLIENT_SECRET'))
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('https://www.googleapis.com/auth/business.manage')
    .setParam('access_type', 'offline')
    .setParam('prompt', 'consent');
}

function authCallback(request) {
  const isAuth = getGMBService().handleCallback(request);
  if (isAuth) clearReviewsCache();
  return HtmlService.createHtmlOutput(isAuth
    ? '✅ Heebee Review Hub is now connected to Google Business Profile. You can close this tab.'
    : '❌ Authentication failed. Please try again.');
}

// Run from the editor when the app says "Google not connected".
// Copy the URL from the execution log, open it, approve.
function authorizeGMB() {
  const service = getGMBService();
  if (service.hasAccess()) { console.log('✅ Already authorized'); return; }
  console.log('Open this URL to authorize: ' + service.getAuthorizationUrl());
}

// Forces a fresh Google sign-in (use if Google keeps failing with 401).
function resetGMBAuth() {
  getGMBService().reset();
  console.log('Google auth cleared. Now run authorizeGMB().');
}

function getGMBAccessToken() {
  const service = getGMBService();
  if (!service.hasAccess()) {
    throw new Error('Google not connected — in Apps Script run authorizeGMB() and open the link it prints' +
      (service.getLastError() ? ' (' + service.getLastError() + ')' : ''));
  }
  return service.getAccessToken();
}

function fetchGMBReviews(branchKey, cutoff) {
  const accountId  = getConfig('GMB_ACCOUNT_ID');
  const locationId = getConfig('GMB_LOCATION_ID_' + branchKey);
  if (!accountId || !locationId) return [];
  const token = getGMBAccessToken();
  cutoff = cutoff || (Date.now() - windowDays_() * DAY_MS);

  let raw = [], pageToken = null, pages = 0;
  do {
    const url = 'https://mybusiness.googleapis.com/v4/' + accountId + '/' + locationId +
                '/reviews?pageSize=50&orderBy=' + encodeURIComponent('updateTime desc') +
                (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      let msg = res.getContentText();
      try { msg = JSON.parse(msg).error.message; } catch (e) {}
      throw new Error('Google ' + branchKey + ' HTTP ' + res.getResponseCode() + ': ' + String(msg).substring(0, 160));
    }
    const data = JSON.parse(res.getContentText());
    const batch = data.reviews || [];
    raw = raw.concat(batch);
    pageToken = data.nextPageToken;
    pages++;
    // Sorted newest-updated first — once a page ends before the cutoff, stop.
    const oldest = batch.length ? toTs_(batch[batch.length - 1].updateTime) : 0;
    if (oldest && oldest < cutoff) break;
  } while (pageToken && pages < 10);

  const out = [];
  raw.forEach(r => {
    const ts = toTs_(r.createTime);
    if (ts < cutoff) return;
    const name   = r.reviewer && r.reviewer.displayName ? r.reviewer.displayName : 'Anonymous';
    const rating = convertGMBRating(r.starRating);
    out.push({
      id: r.reviewId, ref: r.name, platform: 'google', branch: branchKey,
      reviewer: name, rating: rating, ts: ts, date: formatDate(r.createTime),
      text: r.comment || 'No written review.', sentiment: getSentiment(rating),
      status: r.reviewReply ? 'replied' : 'pending', read: true,
      replyText: r.reviewReply && r.reviewReply.comment ? r.reviewReply.comment : '', note: ''
    });
  });
  return out;
}

function readGoogleReviews_(cutoff) {
  if (!getConfig('GMB_ACCOUNT_ID')) throw new Error('GMB_ACCOUNT_ID missing in Config sheet');
  let all = [];
  const errors = [];
  BRANCHES.forEach(b => {
    try { all = all.concat(fetchGMBReviews(b, cutoff)); }
    catch (e) { errors.push(e.message); }
  });
  if (errors.length && !all.length) throw new Error(errors[0]);
  if (errors.length) all.partialError = errors.join(' · ');
  return all;
}

// ══════════════════════════════════════════════════════
// REVIEW STATE — read / note / reply for reviews that don't live in the
// Reviews sheet (Google + QR form). Columns:
//   ID | Status | Read | ReplyText | Note | UpdatedAt | UpdatedBy
// ══════════════════════════════════════════════════════
function ensureStateSheet_() {
  let sheet = SS.getSheetByName('Review_State');
  if (!sheet) {
    sheet = SS.insertSheet('Review_State');
    sheet.appendRow(['ID', 'Status', 'Read', 'ReplyText', 'Note', 'UpdatedAt', 'UpdatedBy']);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#2D1B0E').setFontColor('#FFFFFF');
  }
  return sheet;
}

function readStateMap_() {
  const data = ensureStateSheet_().getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    map[String(data[i][0])] = {
      status: data[i][1] || '', read: data[i][2],
      replyText: data[i][3] || '', note: data[i][4] || ''
    };
  }
  return map;
}

function applyState_(review, s) {
  if (!s) return;
  if (s.status && review.status !== 'replied') review.status = s.status;
  if (s.read !== '' && s.read !== undefined) review.read = s.read === true || String(s.read).toUpperCase() === 'TRUE';
  if (s.replyText && !review.replyText) review.replyText = s.replyText;
  if (s.note) review.note = s.note;
}

// ══════════════════════════════════════════════════════
// FEED BUILD  (the only place that talks to the sources)
// ══════════════════════════════════════════════════════
function buildFeed_() {
  const days   = windowDays_();
  const cutoff = Date.now() - days * DAY_MS;
  const sources = {};
  let reviews = [];

  function run(key, fn) {
    const t0 = Date.now();
    try {
      const list = fn() || [];
      reviews = reviews.concat(list);
      sources[key] = { ok: !list.partialError, count: list.length, ms: Date.now() - t0 };
      if (list.partialError) sources[key].error = list.partialError;
    } catch (e) {
      sources[key] = { ok: false, count: 0, ms: Date.now() - t0, error: String(e.message || e) };
      console.log('Source ' + key + ' failed: ' + e.message);
    }
  }

  run('sheet',  () => readSheetReviews_(cutoff));
  run('form',   () => readFormReviews_(cutoff));
  run('google', () => readGoogleReviews_(cutoff));

  try {
    const state = readStateMap_();
    reviews.forEach(r => applyState_(r, state[String(r.id)]));
  } catch (e) { console.log('State merge failed: ' + e.message); }

  reviews.sort((a, b) => b.ts - a.ts);
  return { reviews: reviews, sources: sources, windowDays: days, builtAt: Date.now() };
}

// ══════════════════════════════════════════════════════
// FEED CACHE  (CacheService, chunked — 100 KB per key limit)
// ══════════════════════════════════════════════════════
const FEED_KEY   = 'hrh_feed_v3';
const FEED_IDX   = 'hrh_feed_v3_idx';
const FEED_TTL   = 21600;   // 6 h (max). keepAliveJob refreshes every 5 min.
const FEED_CHUNK = 90000;

function readFeedCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(FEED_IDX));
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(FEED_KEY + '_' + i);
    const parts = cache.getAll(keys);
    let json = '';
    for (let i = 0; i < n; i++) {
      const part = parts[FEED_KEY + '_' + i];
      if (part == null) return null;
      json += part;
    }
    return JSON.parse(json);
  } catch (e) { return null; }
}

function writeFeedCache_(feed) {
  try {
    const json = JSON.stringify(feed);
    const n = Math.ceil(json.length / FEED_CHUNK);
    const pairs = {};
    for (let i = 0; i < n; i++) pairs[FEED_KEY + '_' + i] = json.slice(i * FEED_CHUNK, (i + 1) * FEED_CHUNK);
    pairs[FEED_IDX] = String(n);
    CacheService.getScriptCache().putAll(pairs, FEED_TTL);
  } catch (e) { console.log('Feed cache write failed: ' + e.message); }
}

function getFeed_(forceFresh) {
  if (!forceFresh) {
    const cached = readFeedCache_();
    if (cached) return cached;
  }
  const feed = buildFeed_();
  writeFeedCache_(feed);
  return feed;
}

// Used by the Slack / Zomato code in Code.gs.
function fetchAllReviews() { return getFeed_().reviews; }

function clearReviewsCache() {
  try { CacheService.getScriptCache().remove(FEED_IDX); } catch (e) {}
  return 'Cache cleared ✓';
}

// Patch one review inside the cached feed (avoids a full rebuild after edits).
function patchFeedCache_(id, updates) {
  const feed = readFeedCache_();
  if (!feed) return;
  const r = feed.reviews.find(x => String(x.id) === String(id));
  if (!r) return;
  ['status', 'read', 'replyText', 'note'].forEach(k => { if (updates[k] !== undefined) r[k] = updates[k]; });
  writeFeedCache_(feed);
}

function computeRatings_(reviews, branch) {
  const result = {};
  ['google', 'zomato', 'swiggy', 'heebee'].forEach(p => {
    let list = reviews.filter(r => r.platform === p && !r.unrated);
    if (branch && branch !== 'all') list = list.filter(r => r.branch === branch);
    const dist = [0, 0, 0, 0, 0];
    list.forEach(r => { if (r.rating >= 1 && r.rating <= 5) dist[r.rating - 1]++; });
    const avg = list.length ? list.reduce((s, r) => s + r.rating, 0) / list.length : 0;
    result[p] = { avg: Math.round(avg * 10) / 10, count: list.length, dist: dist };
  });
  return result;
}

function fetchRatings(branch) { return computeRatings_(fetchAllReviews(), branch); }

// ══════════════════════════════════════════════════════
// KEEP-ALIVE  (time trigger, every 5 min) — rebuilds the feed so web
// requests are always a cache hit.
// ══════════════════════════════════════════════════════
function setupKeepAliveTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'keepAliveJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('keepAliveJob').timeBased().everyMinutes(5).create();
  console.log('Keep-alive trigger created — every 5 minutes.');
}

function keepAliveJob() {
  const feed = getFeed_(true);
  const s = feed.sources;
  console.log('Feed rebuilt: ' + feed.reviews.length + ' reviews (last ' + feed.windowDays + ' days) — ' +
    Object.keys(s).map(k => k + '=' + (s[k].ok ? s[k].count : 'ERROR: ' + s[k].error)).join(' · '));
}

// ══════════════════════════════════════════════════════
// WRITES
// ══════════════════════════════════════════════════════
function saveManualReview(review) {
  const sheet = SS.getSheetByName('Reviews');
  const id = String(Date.now());
  const rating = Number(review.rating) || 0;
  sheet.appendRow([
    id, review.platform, review.branch, review.reviewer, rating,
    new Date(), review.text, review.sentiment || getSentiment(rating), 'pending', true, '', ''
  ]);
  clearReviewsCache();
  return { success: true, id: id };
}

function updateReview(id, updates, userEmail) {
  updates = updates || {};
  // 1. Reviews sheet (Zomato / Swiggy / manual) — search newest rows first
  const sheet = SS.getSheetByName('Reviews');
  const ids = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), 1).getValues();
  for (let i = ids.length - 1; i >= 1; i--) {
    if (String(ids[i][0]) === String(id)) {
      const row = i + 1;
      if (updates.status    !== undefined) sheet.getRange(row, 9).setValue(updates.status);
      if (updates.read      !== undefined) sheet.getRange(row, 10).setValue(updates.read);
      if (updates.replyText !== undefined) sheet.getRange(row, 11).setValue(updates.replyText);
      if (updates.note      !== undefined) sheet.getRange(row, 12).setValue(updates.note);
      patchFeedCache_(id, updates);
      return { success: true };
    }
  }

  // 2. Google / QR form → Review_State sheet (upsert)
  const st   = ensureStateSheet_();
  const data = st.getDataRange().getValues();
  let row = -1;
  for (let i = 1; i < data.length; i++) if (String(data[i][0]) === String(id)) { row = i + 1; break; }
  const cur = row > 0 ? data[row - 1] : [String(id), '', '', '', '', '', ''];
  const next = [
    String(id),
    updates.status    !== undefined ? updates.status    : cur[1],
    updates.read      !== undefined ? updates.read      : cur[2],
    updates.replyText !== undefined ? updates.replyText : cur[3],
    updates.note      !== undefined ? updates.note      : cur[4],
    new Date(), userEmail || ''
  ];
  if (row > 0) st.getRange(row, 1, 1, 7).setValues([next]);
  else st.appendRow(next);
  patchFeedCache_(id, updates);
  return { success: true };
}

function postGoogleReply(reviewId, replyText, branch, ref) {
  if (!replyText) return { success: false, error: 'Reply is empty' };
  const token = getGMBAccessToken();

  // Resolve the review's full resource name without re-downloading every review
  let name = ref;
  if (!name) {
    const r = fetchAllReviews().find(x => String(x.id) === String(reviewId));
    if (r && r.ref) name = r.ref;
    else {
      const b = branch || (r && r.branch);
      const loc = b && getConfig('GMB_LOCATION_ID_' + b);
      if (!loc) return { success: false, error: 'Could not find location for review' };
      name = getConfig('GMB_ACCOUNT_ID') + '/' + loc + '/reviews/' + reviewId;
    }
  }

  const res = UrlFetchApp.fetch('https://mybusiness.googleapis.com/v4/' + name + '/reply', {
    method: 'put', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ comment: replyText }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    return { success: false, error: 'Google ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 160) };
  }
  patchFeedCache_(reviewId, { status: 'replied', replyText: replyText });
  return { success: true };
}

// ══════════════════════════════════════════════════════
// TEMPLATES
// Columns: ID | Name | Text | CreatedAt | UpdatedAt
// ══════════════════════════════════════════════════════
function ensureTemplatesSheet_() {
  let sheet = SS.getSheetByName('Templates');
  if (!sheet) {
    sheet = SS.insertSheet('Templates');
    sheet.appendRow(['ID', 'Name', 'Text', 'CreatedAt', 'UpdatedAt']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#2D1B0E').setFontColor('#FFFFFF');
  }
  return sheet;
}

function fetchTemplates() {
  const data = ensureTemplatesSheet_().getDataRange().getValues();
  const templates = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    templates.push({ id: data[i][0], name: data[i][1], text: data[i][2] });
  }
  return templates;
}

function apiSaveTemplate(id, name, text) {
  name = String(name || '').trim();
  text = String(text || '').trim();
  if (!name || !text) return { ok: false, error: 'Name and text required' };
  const sheet = ensureTemplatesSheet_();
  const data  = sheet.getDataRange().getValues();
  const now   = new Date();
  if (id) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        sheet.getRange(i + 1, 2, 1, 2).setValues([[name, text]]);
        sheet.getRange(i + 1, 5).setValue(now);
        return { ok: true, template: { id: id, name: name, text: text } };
      }
    }
    return { ok: false, error: 'Template not found' };
  }
  const newId = 'tpl_' + now.getTime();
  sheet.appendRow([newId, name, text, now, now]);
  return { ok: true, template: { id: newId, name: name, text: text } };
}

function apiDeleteTemplate(id) {
  if (!id) return { ok: false, error: 'Missing id' };
  const sheet = ensureTemplatesSheet_();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) { sheet.deleteRow(i + 1); return { ok: true }; }
  }
  return { ok: false, error: 'Template not found' };
}

// ══════════════════════════════════════════════════════
// AUTH
// Users sheet: Email | Password | Name | Role | Branch | Active
// Passwords are stored as "sha256$<salt>$<hash>". A plain password typed into
// the sheet still works once and is replaced by its hash on that login — so
// to reset someone's password, just type a new one into column B.
// ══════════════════════════════════════════════════════
function _sha256(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b + 256) & 0xff).toString(16)).slice(-2)).join('');
}

function hashPassword_(password) {
  const salt = Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  return 'sha256$' + salt + '$' + _sha256(salt + '|' + password);
}

function passwordMatches_(stored, given) {
  stored = String(stored || '').trim();
  if (!stored || !given) return false;
  if (stored.indexOf('sha256$') === 0) {
    const parts = stored.split('$');
    return parts.length === 3 && _sha256(parts[1] + '|' + given) === parts[2];
  }
  return stored === String(given);
}

function getApiSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('API_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('API_SECRET', s);
  }
  return s;
}

function readUsers_() {
  return SS.getSheetByName('Users').getDataRange().getValues();
}

function _findUser(email) {
  const target = String(email || '').toLowerCase().trim();
  const data = readUsers_();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[0]).toLowerCase().trim() === target) {
      return {
        row: i + 1, email: target, password: row[1],
        name: String(row[2] || '').trim(), role: String(row[3] || '').trim(),
        branch: String(row[4] || '').trim(),
        active: row[5] === true || String(row[5]).toUpperCase() === 'TRUE'
      };
    }
  }
  return null;
}

function authenticateUser(email, password) {
  const u = _findUser(email);
  if (!u || !u.active || !passwordMatches_(u.password, password)) return { success: false };
  // Upgrade a plain-text password to a hash on first successful login
  if (String(u.password).indexOf('sha256$') !== 0) {
    SS.getSheetByName('Users').getRange(u.row, 2).setValue(hashPassword_(String(password)));
  }
  return { success: true, name: u.name, role: u.role, branch: u.branch, email: u.email };
}

// Run once from the editor to hash every plain-text password right away.
function hashAllPasswords() {
  const sheet = SS.getSheetByName('Users');
  const data = sheet.getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    const p = String(data[i][1] || '').trim();
    if (p && p.indexOf('sha256$') !== 0) { sheet.getRange(i + 1, 2).setValue(hashPassword_(p)); n++; }
  }
  console.log('Hashed ' + n + ' password(s).');
}

// Max 8 wrong attempts per email per 15 minutes
function loginLocked_(email) {
  return Number(CacheService.getScriptCache().get('login_fail_' + email) || 0) >= 8;
}
function noteLoginFail_(email) {
  const c = CacheService.getScriptCache();
  c.put('login_fail_' + email, String(Number(c.get('login_fail_' + email) || 0) + 1), 900);
}

function _makeToken(email) {
  const exp = Date.now() + SESSION_DAYS * DAY_MS;
  const sig = _sha256(email + '|' + exp + '|' + getApiSecret_());
  return Utilities.base64EncodeWebSafe(email + '|' + exp + '|' + sig);
}

function _verifyToken(token) {
  if (!token) return null;
  try {
    const decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
    const [email, exp, sig] = decoded.split('|');
    if (!email || !exp || !sig) return null;
    if (Date.now() > Number(exp)) return null;
    if (_sha256(email + '|' + exp + '|' + getApiSecret_()) !== sig) return null;
    return { email: email, exp: Number(exp) };
  } catch (e) { return null; }
}

function _publicUser(u) {
  return { email: u.email, name: u.name, role: u.role, branch: u.branch };
}

function _session(u) {
  return { ok: true, token: _makeToken(u.email), expiresAt: Date.now() + SESSION_DAYS * DAY_MS, user: _publicUser(u) };
}

function apiLogin(email, password) {
  if (!email || !password) return { ok: false, error: 'Email and password are required.' };
  const key = String(email).toLowerCase().trim();
  if (loginLocked_(key)) return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' };
  const auth = authenticateUser(key, password);
  if (!auth.success) { noteLoginFail_(key); return { ok: false, error: 'Invalid credentials.' }; }
  return _session(auth);
}

function apiVerifySession(token) {
  const s = _verifyToken(token);
  if (!s) return { ok: false, error: 'expired' };
  const u = _findUser(s.email);
  if (!u || !u.active) return { ok: false, error: 'inactive' };
  return { ok: true, user: _publicUser(u), expiresAt: s.exp };
}

// Run this to log everyone out (e.g. after a password leak).
function rotateApiSecret() {
  PropertiesService.getScriptProperties().deleteProperty('API_SECRET');
  getApiSecret_();
  console.log('Secret rotated — all sessions are now logged out.');
}

// ── Biometric (device pairing) ─────────────────────────
function _ensureBiometricSheet() {
  let sheet = SS.getSheetByName('BiometricCreds');
  if (!sheet) {
    sheet = SS.insertSheet('BiometricCreds');
    sheet.appendRow(['Email', 'CredentialID', 'CreatedAt', 'LastUsed']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#2D1B0E').setFontColor('#FFFFFF');
  }
  return sheet;
}

function apiRegisterBiometric(email, credentialId) {
  if (!credentialId) return { ok: false, error: 'Missing credentialId' };
  const sheet = _ensureBiometricSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === email && String(data[i][1]) === credentialId) {
      sheet.getRange(i + 1, 4).setValue(new Date());
      return { ok: true };
    }
  }
  sheet.appendRow([email, credentialId, new Date(), new Date()]);
  return { ok: true };
}

function apiVerifyBiometric(email, credentialId) {
  if (!email || !credentialId) return { ok: false, error: 'Missing fields' };
  const target = String(email).toLowerCase().trim();
  if (loginLocked_(target)) return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' };
  const sheet = _ensureBiometricSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === target && String(data[i][1]) === credentialId) {
      sheet.getRange(i + 1, 4).setValue(new Date());
      const u = _findUser(target);
      if (!u || !u.active) return { ok: false, error: 'Account inactive' };
      return _session(u);
    }
  }
  noteLoginFail_(target);
  return { ok: false, error: 'Biometric credential not recognised on this device.' };
}

// ══════════════════════════════════════════════════════
// HTTP API
// ══════════════════════════════════════════════════════
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'ping') return _json({ ok: true, time: new Date().toISOString() });
  return _json({ ok: true, service: 'Heebee Review Hub API', version: 'v3' });
}

function doPost(e) {
  let body = {};
  try {
    if (e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return _json({ ok: false, error: 'Invalid JSON body' });
  }
  return _json(handleApi(body));
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function _normalize(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'No response' };
  if (result.ok !== undefined) return result;
  if (result.success === true)  return Object.assign({ ok: true }, result);
  if (result.success === false) return { ok: false, error: result.error || 'Operation failed' };
  return Object.assign({ ok: true }, result);
}

function feedResponse_(feed) {
  return {
    ok: true, reviews: feed.reviews, ratings: computeRatings_(feed.reviews, 'all'),
    sources: feed.sources, windowDays: feed.windowDays, builtAt: feed.builtAt
  };
}

function handleApi(p) {
  try {
    switch (p.action) {
      case 'ping':          return { ok: true, time: new Date().toISOString() };
      case 'login':         return apiLogin(p.email, p.pin || p.password);
      case 'verifySession': return apiVerifySession(p.token);
      case 'verifyBiometric': return apiVerifyBiometric(p.email, p.credentialId);
    }

    // Everything below needs a valid session
    const session = _verifyToken(p.token);
    if (!session) return { ok: false, error: 'Session expired. Please log in again.', code: 'SESSION_EXPIRED' };
    const user = _findUser(session.email);
    if (!user || !user.active) return { ok: false, error: 'Account inactive.', code: 'SESSION_EXPIRED' };

    switch (p.action) {
      case 'fetchReviews':     return feedResponse_(getFeed_(false));
      case 'refreshReviews':   return feedResponse_(getFeed_(true));
      case 'fetchRatings':     return { ok: true, ratings: fetchRatings(p.branch || 'all') };
      case 'fetchTemplates':   return { ok: true, templates: fetchTemplates() };
      case 'saveTemplate':     return apiSaveTemplate(p.id, p.name, p.text);
      case 'deleteTemplate':   return apiDeleteTemplate(p.id);
      case 'updateReview':     return _normalize(updateReview(p.id, p.updates || {}, user.email));
      case 'saveManualReview': return _normalize(saveManualReview(p.review || {}));
      case 'postGoogleReply':  return _normalize(postGoogleReply(p.reviewId, p.replyText, p.branch, p.ref));
      case 'clearCache':       clearReviewsCache(); return { ok: true };
      case 'registerBiometric': return apiRegisterBiometric(user.email, p.credentialId);
      default:                 return { ok: false, error: 'Unknown action: ' + p.action };
    }
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ══════════════════════════════════════════════════════
// DIAGNOSTICS — run from the editor, read the Execution log
// ══════════════════════════════════════════════════════
function diagnoseReviewHub() {
  const feed = buildFeed_();
  console.log('Window: last ' + feed.windowDays + ' days → ' + feed.reviews.length + ' reviews');
  Object.keys(feed.sources).forEach(k => {
    const s = feed.sources[k];
    console.log((s.ok ? '✅ ' : '❌ ') + k + ': ' + s.count + ' reviews in ' + s.ms + ' ms' + (s.error ? ' — ' + s.error : ''));
  });
  ['google', 'zomato', 'swiggy', 'heebee'].forEach(p => {
    const list = feed.reviews.filter(r => r.platform === p);
    console.log('  ' + p + ': ' + list.length + (list.length ? ' (newest ' + list[0].date + ')' : ''));
  });
  console.log('Payload size: ' + Math.round(JSON.stringify(feed).length / 1024) + ' KB');
  writeFeedCache_(feed);
}
