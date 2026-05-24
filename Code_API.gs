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
        return _json(_guard(p, () => ({ ok: true, reviews: fetchAllReviews() })));

      case 'fetchReviewsChunked':
        return _json(_guard(p, () => ({
          ok: true,
          data: fetchAllReviewsChunked(Number(p.offset) || 0, Number(p.limit) || 50)
        })));

      case 'fetchTemplates':
        return _json(_guard(p, () => ({ ok: true, templates: fetchTemplates() })));

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
        return _json(_guard(p, () => ({ ok: true, msg: clearReviewsCache() })));

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
