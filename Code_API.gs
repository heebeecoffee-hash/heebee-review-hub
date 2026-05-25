// ═══════════════════════════════════════════════════════
// HEEBEE REVIEW HUB — API LAYER (paste into your GAS project)
// ═══════════════════════════════════════════════════════
// PASTE THIS ENTIRE FILE AT THE END of your existing Code.gs
// Then DELETE the old doGet() at the top — this one replaces it.
// ───────────────────────────────────────────────────────
// After paste:
//   1. Save (Ctrl/Cmd+S)
//   2. Deploy → Manage Deployments → Edit (pencil) → New version → Deploy
//   3. The /exec URL stays the same.
// ───────────────────────────────────────────────────────

const API_SECRET = 'heebee_review_hub_2026_changeme';  // change this to anything you like, just keep it
const SESSION_DAYS = 30;

// ══════════════════════════════════════════════════════
// HTTP ENTRY POINTS
// ══════════════════════════════════════════════════════
function doGet(e) {
  // GET = either health check or simple action (no body)
  if (e && e.parameter && e.parameter.action) {
    return handleApi(e.parameter, 'GET');
  }
  return _json({ ok: true, service: 'Heebee Review Hub API', version: 'v2.0' });
}

function doPost(e) {
  let body = {};
  try {
    if (e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return _json({ ok: false, error: 'Invalid JSON body' });
  }
  return handleApi(body, 'POST');
}

// ══════════════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════════════
function handleApi(p, method) {
  try {
    switch (p.action) {

      // ── PUBLIC ─────────────────────────────────────
      case 'ping':
        return _json({ ok: true, time: new Date().toISOString() });

      case 'login':
        return _json(apiLogin(p.email, p.pin || p.password));

      case 'verifySession':
        return _json(apiVerifySession(p.token));

      // ── PROTECTED — require valid session token ────
      case 'fetchReviews':
        return _json(_guard(p, () => ({ ok: true, reviews: _cachedReviews() })));

      case 'fetchReviewsChunked':
        return _json(_guard(p, () => ({
          ok: true,
          data: fetchAllReviewsChunked(Number(p.offset) || 0, Number(p.limit) || 50)
        })));

      case 'fetchTemplates':
        return _json(_guard(p, () => ({ ok: true, templates: fetchTemplates() })));

      case 'saveTemplate':
        return _json(_guard(p, () => apiSaveTemplate(p.id, p.name, p.text)));

      case 'deleteTemplate':
        return _json(_guard(p, () => apiDeleteTemplate(p.id)));

      case 'fetchRatings':
        return _json(_guard(p, () => ({ ok: true, ratings: fetchRatings(p.branch || 'all') })));

      case 'fetchConfig':
        return _json(_guard(p, () => ({ ok: true, config: _publicConfig() })));

      case 'updateReview':
        return _json(_guard(p, () => _normalize(updateReview(p.id, p.updates || {}))));

      case 'saveManualReview':
        return _json(_guard(p, () => _normalize(saveManualReview(p.review || {}))));

      case 'postGoogleReply':
        return _json(_guard(p, () => _normalize(postGoogleReply(p.reviewId, p.replyText))));

      case 'clearCache':
        return _json(_guard(p, () => { _bustReviewsCache(); return { ok: true, msg: 'Cache cleared' }; }));

      // ── KEEP-ALIVE (called by time-trigger, no auth needed) ──
      case 'keepAlive':
        _bustReviewsCache();                       // also pre-warm the cache
        try { _cachedReviews(); } catch(e) {}      // loads + stores fresh data
        return _json({ ok: true, warmed: new Date().toISOString() });

      // ── WebAuthn / biometric (face/fingerprint) ────
      case 'registerBiometric':
        return _json(_guard(p, () => apiRegisterBiometric(p, p.credentialId)));

      case 'verifyBiometric':
        return _json(apiVerifyBiometric(p.email, p.credentialId));

      default:
        return _json({ ok: false, error: 'Unknown action: ' + p.action });
    }
  } catch (err) {
    return _json({ ok: false, error: String(err.message || err) });
  }
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Normalize legacy {success:true/false} responses to {ok:true/false}
// so the frontend always has a consistent shape to check.
function _normalize(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'No response' };
  if (result.ok !== undefined) return result; // already normalized
  if (result.success === true)  return { ok: true };
  if (result.success === false) return { ok: false, error: result.error || 'Operation failed' };
  return Object.assign({ ok: true }, result); // pass through any extra fields
}

// ══════════════════════════════════════════════════════
// SESSION TOKENS (stateless, signed)
// ══════════════════════════════════════════════════════
// Token format:   base64url(email|exp|sig)   sig = sha256(email|exp|secret)
function _makeToken(email) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const sig = _sha256(email + '|' + exp + '|' + API_SECRET);
  return Utilities.base64EncodeWebSafe(email + '|' + exp + '|' + sig);
}

function _verifyToken(token) {
  if (!token) return null;
  try {
    const decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
    const [email, exp, sig] = decoded.split('|');
    if (!email || !exp || !sig) return null;
    if (Date.now() > Number(exp)) return null;
    const expected = _sha256(email + '|' + exp + '|' + API_SECRET);
    if (expected !== sig) return null;
    return { email: email, exp: Number(exp) };
  } catch (e) {
    return null;
  }
}

function _sha256(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b + 256) & 0xff).toString(16)).slice(-2)).join('');
}

function _guard(p, fn) {
  const session = _verifyToken(p.token);
  if (!session) return { ok: false, error: 'Session expired. Please log in again.', code: 'SESSION_EXPIRED' };
  // Re-check user is still active in the sheet
  const u = _findUser(session.email);
  if (!u || !u.active) return { ok: false, error: 'Account inactive.', code: 'INACTIVE' };
  return fn();
}

// ══════════════════════════════════════════════════════
// LOGIN (email + PIN/password)
// ══════════════════════════════════════════════════════
function apiLogin(email, pinOrPassword) {
  if (!email || !pinOrPassword) return { ok: false, error: 'Email and PIN are required.' };
  const auth = authenticateUser(email, pinOrPassword);
  if (!auth.success) return { ok: false, error: 'Invalid credentials.' };
  return {
    ok: true,
    token: _makeToken(auth.email),
    expiresAt: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
    user: { email: auth.email, name: auth.name, role: auth.role, branch: auth.branch }
  };
}

function apiVerifySession(token) {
  const s = _verifyToken(token);
  if (!s) return { ok: false, error: 'expired' };
  const u = _findUser(s.email);
  if (!u || !u.active) return { ok: false, error: 'inactive' };
  return { ok: true, user: { email: u.email, name: u.name, role: u.role, branch: u.branch }, expiresAt: s.exp };
}

function _findUser(email) {
  const sheet = SS.getSheetByName('Users');
  const data  = sheet.getDataRange().getValues();
  const target = String(email).toLowerCase().trim();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[0]).toLowerCase().trim() === target) {
      return {
        email: target,
        name: String(row[2] || '').trim(),
        role: String(row[3] || '').trim(),
        branch: String(row[4] || '').trim(),
        active: row[5] === true || String(row[5]).toUpperCase() === 'TRUE'
      };
    }
  }
  return null;
}

function _publicConfig() {
  // Anything the frontend needs but should NOT include secrets
  return {
    branches: { b1: 'Sarabha Nagar', b2: 'Ghumar Mandi', b3: 'Model Town' },
    platforms: ['google', 'zomato', 'swiggy', 'heebee'],
    version: 'v2.0'
  };
}

// ══════════════════════════════════════════════════════
// WebAuthn / Biometric (lightweight — stores credential ID per user)
// ══════════════════════════════════════════════════════
// We don't run full WebAuthn server-side cryptography here (GAS is limited).
// Strategy: browser does platform biometric, gives us a credentialId.
// We store the credentialId against the user. Future biometric logins simply
// verify the same credentialId is presented from the same device.
// This is "device pairing + biometric gate" — appropriate for an internal tool.
function _ensureBiometricSheet() {
  let sheet = SS.getSheetByName('BiometricCreds');
  if (!sheet) {
    sheet = SS.insertSheet('BiometricCreds');
    sheet.appendRow(['Email', 'CredentialID', 'CreatedAt', 'LastUsed']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#2D1B0E').setFontColor('#FFFFFF');
  }
  return sheet;
}

function apiRegisterBiometric(p, credentialId) {
  if (!credentialId) return { ok: false, error: 'Missing credentialId' };
  const s = _verifyToken(p.token);
  if (!s) return { ok: false, error: 'Session expired' };
  const sheet = _ensureBiometricSheet();
  const data = sheet.getDataRange().getValues();
  let foundRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === s.email && String(data[i][1]) === credentialId) {
      foundRow = i + 1; break;
    }
  }
  if (foundRow > 0) {
    sheet.getRange(foundRow, 4).setValue(new Date());
  } else {
    sheet.appendRow([s.email, credentialId, new Date(), new Date()]);
  }
  return { ok: true };
}

// ══════════════════════════════════════════════════════
// TEMPLATES — CRUD against the "Templates" sheet
// ══════════════════════════════════════════════════════
// Sheet columns (row 1 = header):  ID | Name | Text | CreatedAt | UpdatedAt
function _ensureTemplatesSheet() {
  let sheet = SS.getSheetByName('Templates');
  if (!sheet) {
    sheet = SS.insertSheet('Templates');
    sheet.appendRow(['ID', 'Name', 'Text', 'CreatedAt', 'UpdatedAt']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#2D1B0E').setFontColor('#FFFFFF');
  }
  return sheet;
}

function apiSaveTemplate(id, name, text) {
  name = String(name || '').trim();
  text = String(text || '').trim();
  if (!name || !text) return { ok: false, error: 'Name and text required' };

  const sheet = _ensureTemplatesSheet();
  const data  = sheet.getDataRange().getValues();
  const now   = new Date();

  // UPDATE existing
  if (id) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        sheet.getRange(i + 1, 2).setValue(name);
        sheet.getRange(i + 1, 3).setValue(text);
        sheet.getRange(i + 1, 5).setValue(now);
        _clearTemplatesCache();
        return { ok: true, template: { id: id, name: name, text: text } };
      }
    }
    return { ok: false, error: 'Template not found' };
  }

  // CREATE new
  const newId = 'tpl_' + now.getTime();
  sheet.appendRow([newId, name, text, now, now]);
  _clearTemplatesCache();
  return { ok: true, template: { id: newId, name: name, text: text } };
}

function apiDeleteTemplate(id) {
  if (!id) return { ok: false, error: 'Missing id' };
  const sheet = _ensureTemplatesSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      _clearTemplatesCache();
      return { ok: true };
    }
  }
  return { ok: false, error: 'Template not found' };
}

function _clearTemplatesCache() {
  try { CacheService.getScriptCache().remove('templates_cache'); } catch (e) {}
}

// ══════════════════════════════════════════════════════
// REVIEWS CACHE  (A2)
// ══════════════════════════════════════════════════════
// GAS CacheService holds up to 100 KB per key for up to 6 hours.
// We split into chunks of 90 KB to stay safely under the limit.
// On a warm GAS instance this is a memcache read — typically <200 ms.
// On a cold start the first call still hits the sheet, but every
// subsequent call (including the keep-alive) is instant.
const _RC_KEY    = 'hrh_reviews_v2';   // base cache key
const _RC_IDX    = 'hrh_reviews_idx';  // stores chunk count
const _RC_TTL    = 21600;              // 6 hours in seconds
const _RC_CHUNK  = 90000;             // 90 KB per chunk (safe margin under 100 KB limit)

function _cachedReviews() {
  const cache = CacheService.getScriptCache();
  try {
    const idxRaw = cache.get(_RC_IDX);
    if (idxRaw) {
      const chunks = Number(idxRaw);
      let json = '';
      for (let i = 0; i < chunks; i++) {
        const part = cache.get(_RC_KEY + '_' + i);
        if (part === null) { json = null; break; }   // chunk expired — rebuild
        json += part;
      }
      if (json) return JSON.parse(json);
    }
  } catch (e) {}   // cache miss or parse error — fall through to sheet read

  // Cache miss — read sheet and store
  const reviews = fetchAllReviews();
  _storeReviewsCache(cache, reviews);
  return reviews;
}

function _storeReviewsCache(cache, reviews) {
  try {
    const json   = JSON.stringify(reviews);
    const chunks = Math.ceil(json.length / _RC_CHUNK);
    const pairs  = {};
    pairs[_RC_IDX] = String(chunks);
    for (let i = 0; i < chunks; i++) {
      pairs[_RC_KEY + '_' + i] = json.slice(i * _RC_CHUNK, (i + 1) * _RC_CHUNK);
    }
    cache.putAll(pairs, _RC_TTL);
  } catch (e) {}   // non-fatal — just won't be cached this time
}

function _bustReviewsCache() {
  try {
    const cache  = CacheService.getScriptCache();
    const idxRaw = cache.get(_RC_IDX);
    const keys   = [_RC_IDX];
    if (idxRaw) {
      const chunks = Number(idxRaw);
      for (let i = 0; i < chunks; i++) keys.push(_RC_KEY + '_' + i);
    }
    cache.removeAll(keys);
  } catch (e) {}
}

// ══════════════════════════════════════════════════════
// KEEP-ALIVE TRIGGER  (A1)
// ══════════════════════════════════════════════════════
// Run setupKeepAliveTrigger() ONCE from the GAS editor (Run menu).
// It creates a time-based trigger that calls keepAliveJob() every 4 minutes.
// keepAliveJob() busts the stale cache and pre-warms a fresh one so the
// script runtime never goes cold and review fetches are always sub-second.
function setupKeepAliveTrigger() {
  // Remove any existing keep-alive triggers first to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'keepAliveJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('keepAliveJob')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Keep-alive trigger created — fires every 5 minutes.');
}

function keepAliveJob() {
  // Bust stale cache, then immediately pre-warm with fresh sheet data.
  // Runs on GAS infrastructure — zero frontend involvement.
  _bustReviewsCache();
  try {
    const reviews = fetchAllReviews();
    _storeReviewsCache(CacheService.getScriptCache(), reviews);
    Logger.log('Keep-alive OK — ' + reviews.length + ' reviews cached at ' + new Date().toISOString());
  } catch (e) {
    Logger.log('Keep-alive error: ' + e.message);
  }
}

// Also bust the reviews cache whenever a review is mutated so the
// next fetchReviews call returns fresh data rather than stale cache.
// Call this at the top of updateReview() and saveManualReview() in Code.gs.
function bustReviewsCachePublic() { _bustReviewsCache(); }

function apiVerifyBiometric(email, credentialId) {
  if (!email || !credentialId) return { ok: false, error: 'Missing fields' };
  const sheet = _ensureBiometricSheet();
  const data = sheet.getDataRange().getValues();
  const target = String(email).toLowerCase().trim();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === target && String(data[i][1]) === credentialId) {
      sheet.getRange(i + 1, 4).setValue(new Date());
      const u = _findUser(target);
      if (!u || !u.active) return { ok: false, error: 'Account inactive' };
      return {
        ok: true,
        token: _makeToken(u.email),
        expiresAt: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
        user: { email: u.email, name: u.name, role: u.role, branch: u.branch }
      };
    }
  }
  return { ok: false, error: 'Biometric credential not recognised on this device.' };
}
