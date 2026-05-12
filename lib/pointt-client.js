'use strict';

const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');

const POINTT_HOST = 'pointt-api.bosch-thermotechnology.com';
const POINTT_BASE = '/pointt-api/api/v1/gateways';
const TOKEN_HOST = 'singlekey-id.com';
const TOKEN_PATH = '/auth/connect/token';
const CLIENT_ID = '762162C0-FA2D-4540-AE66-6489F189FADC';
const REDIRECT_URI = 'com.bosch.tt.dashtt.pointt://app/login';
const CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklm';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

class PointtClient {

  constructor({ deviceId, accessToken, refreshToken, tokenExpiresAt, onTokenRefresh }) {
    this.deviceId = deviceId;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenExpiresAt = tokenExpiresAt || 0;
    this.onTokenRefresh = onTokenRefresh || (() => {});
  }

  // ---- Public interface (matches bosch-xmpp interface) ----

  async get(path) {
    await this._ensureToken();
    return this._request('GET', path, null);
  }

  async put(path, payload) {
    await this._ensureToken();
    return this._request('PUT', path, payload);
  }

  // No-op — kept for compatibility with bosch-xmpp interface
  end() {}

  // ---- Token management ----

  async _ensureToken() {
    if (Date.now() >= this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      await this._refreshToken();
    }
  }

  async _refreshToken() {
    const body = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: CLIENT_ID,
    });

    const data = await this._httpsPost(TOKEN_HOST, TOKEN_PATH, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in * 1000);

    await this.onTokenRefresh({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      token_expires_at: this.tokenExpiresAt,
    });
  }

  // ---- HTTP request wrapper ----

  _request(method, resourcePath, body) {
    const urlPath = `${POINTT_BASE}/${this.deviceId}/resource${resourcePath}`;
    const bodyStr = body != null ? JSON.stringify(body) : null;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: POINTT_HOST,
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
          ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode === 204) return resolve({ status: 'ok' });
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode} on ${method} ${resourcePath}`);
            err.statusCode = res.statusCode;
            err.body = raw;
            return reject(err);
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Invalid JSON response from ${method} ${resourcePath}: ${raw.slice(0, 120)}`));
          }
        });
      });

      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // Generic HTTPS POST helper (used for token operations — not Pointt API)
  _httpsPost(host, path, body, headers) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: host,
        path,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            const err = new Error(`Token endpoint HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.body = raw;
            return reject(err);
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Invalid JSON from token endpoint: ${raw.slice(0, 120)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ---- Static OAuth2 PKCE helpers (used by driver.js during pairing) ----

  static buildAuthUrl() {
    const codeChallenge = crypto
      .createHash('sha256')
      .update(CODE_VERIFIER)
      .digest('base64url');

    const params = querystring.stringify({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: 'openid email profile offline_access pointt.gateway.claiming pointt.gateway.removal pointt.gateway.list pointt.gateway.users pointt.gateway.resource.dashapp pointt.castt.flow.token-exchange bacon',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'login',
      style_id: 'tt_bsch',
    });

    return `https://${TOKEN_HOST}/auth/connect/authorize?${params}`;
  }

  /**
   * List all gateways/heat pumps associated with the authenticated account.
   * Returns an array of { id, name } objects.
   */
  static async listGateways(accessToken) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: POINTT_HOST,
        path: '/pointt-api/api/v1/gateways',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      };
      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            const err = new Error(`Gateway list HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.body = raw;
            return reject(err);
          }
          try {
            const data = JSON.parse(raw);
            // Normalise to array of { id, name }
            const list = Array.isArray(data) ? data : (data.gateways || data.items || [data]);
            resolve(list.map(g => ({
              id: String(g.id || g.gatewayId || g.serialNumber || g.deviceId || ''),
              name: g.name || g.deviceName || g.description || 'IVT Heat pump',
            })).filter(g => g.id));
          } catch (e) {
            reject(new Error(`Could not parse gateway list: ${raw.slice(0, 120)}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  static extractCode(callbackUrl) {
    // Accepts: deep link (com.bosch.tt.dashtt.pointt://...) or any URL with ?code=
    const match = callbackUrl.match(/[?&]code=([^&]+)/);
    if (!match) throw new Error('No authorization code found in callback URL');
    return decodeURIComponent(match[1]);
  }

  /**
   * Try to complete the OAuth callback server-side by following the redirect
   * chain from a redirection-page URL or a bare callback URL.
   * Works when the server's interaction state is stored in server-side cache
   * (keyed by the f= token), not in the browser session cookie.
   *
   * Returns the authorization code string on success.
   * Throws if the server redirects to the login page (session required).
   */
  static async tryCompleteRedirection(startUrl) {
    const rawGet = (url) => new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (e) { return reject(new Error(`Bad URL: ${url}`)); }
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HomeyIVT/1.1)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
      }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });

    let url = startUrl;
    for (let i = 0; i < 10; i++) {
      const res = await rawGet(url);
      const loc = res.headers['location'];

      // HTTP redirect
      if (res.status >= 300 && res.status < 400 && loc) {
        if (loc.startsWith('com.bosch.tt.dashtt.pointt://')) {
          const match = loc.match(/[?&]code=([^&]+)/);
          if (match) return decodeURIComponent(match[1]);
          throw new Error('Deep link received but no code: ' + loc.slice(0, 100));
        }
        url = loc.startsWith('http') ? loc : `https://${TOKEN_HOST}${loc}`;
        continue;
      }

      // JS countdown/redirection page — extract callback URL from URL params
      if (res.status === 200) {
        try {
          const parsed = new URL(url);
          if (parsed.pathname.includes('redirection')) {
            const returnUrl = parsed.searchParams.get('returnUrl');
            const f = parsed.searchParams.get('f');
            if (returnUrl) {
              url = `https://${TOKEN_HOST}${returnUrl}${f ? '&f=' + encodeURIComponent(f) : ''}`;
              continue;
            }
          }
        } catch (_) { /* not a parseable redirection URL */ }
      }

      const err = new Error(`Server-side callback failed — status ${res.status} at ${url.slice(0, 80)}`);
      err.redirectDest = url;
      err.redirectStatus = res.status;
      throw err;
    }
    throw new Error('Too many redirects during server-side callback');
  }

  /**
   * Headless login: start a fresh OAuth session, POST credentials to the
   * SingleKey ID login form, follow the redirect chain and return tokens.
   * No browser required — the user just enters email + password.
   */
  static async authenticate(email, password) {
    const cookies = {};

    const saveCookies = (headerVal) => {
      if (!headerVal) return;
      const list = Array.isArray(headerVal) ? headerVal : [headerVal];
      for (const c of list) {
        const semi = c.indexOf(';');
        const kv = semi > 0 ? c.slice(0, semi) : c;
        const eq = kv.indexOf('=');
        if (eq > 0) cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
      }
    };

    const cookieStr = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

    // Low-level HTTP helper — does NOT follow redirects
    const rawRequest = (method, url, extraHeaders, body) => new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (e) { return reject(new Error(`Bad URL: ${url}`)); }
      const buf = body ? Buffer.from(body) : null;
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; HomeyIVT/1.1)',
          Cookie: cookieStr(),
          ...(buf ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length } : {}),
          ...extraHeaders,
        },
      }, res => {
        saveCookies(res.headers['set-cookie']);
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
      });
      req.on('error', reject);
      if (buf) req.write(buf);
      req.end();
    });

    // Follow redirect chain — handles HTTP 302 AND the JS-based sv-se/redirection page
    const followRedirects = async (startUrl, maxHops = 10) => {
      let url = startUrl;
      for (let i = 0; i < maxHops; i++) {
        console.log(`[PointtAuth] hop ${i}: GET ${url.slice(0, 120)}`);
        const res = await rawRequest('GET', url, {}, null);
        const loc = res.headers.location;
        console.log(`[PointtAuth] hop ${i}: status=${res.status} location=${loc ? loc.slice(0, 120) : 'none'}`);

        // HTTP redirect
        if (res.status >= 300 && res.status < 400 && loc) {
          if (loc.startsWith('com.bosch.tt.dashtt.pointt://')) return { type: 'deeplink', url: loc };
          url = loc.startsWith('http') ? loc : `https://${TOKEN_HOST}${loc}`;
          continue;
        }

        // JavaScript redirect page: /sv-se/redirection?returnUrl=...&f=...
        // The page JS navigates to returnUrl after a countdown — we follow it directly
        // since we now have the session cookies from the login POST.
        if (res.status === 200) {
          try {
            const parsed = new URL(url);
            if (parsed.pathname.includes('redirection')) {
              const returnUrl = parsed.searchParams.get('returnUrl');
              const f = parsed.searchParams.get('f');
              console.log(`[PointtAuth] redirection page detected: returnUrl=${returnUrl ? returnUrl.slice(0, 80) : 'MISSING'} f=${f}`);
              if (returnUrl) {
                const callbackPath = f ? `${returnUrl}&f=${encodeURIComponent(f)}` : returnUrl;
                url = `https://${TOKEN_HOST}${callbackPath}`;
                continue;
              }
            }
          } catch (_) { /* not a parseable URL — fall through */ }
        }

        console.log(`[PointtAuth] landed on page: status=${res.status} url=${url.slice(0, 120)}`);
        console.log(`[PointtAuth] page body snippet: ${res.body.slice(0, 400)}`);
        return { type: 'page', url, body: res.body, status: res.status };
      }
      throw new Error('Too many redirects during authentication');
    };

    // — Step 1: Start auth flow, arrive at the login page —
    const codeChallenge = crypto.createHash('sha256').update(CODE_VERIFIER).digest('base64url');
    const authUrl = `https://${TOKEN_HOST}/auth/connect/authorize?` + querystring.stringify({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: 'openid email profile offline_access pointt.gateway.claiming pointt.gateway.removal pointt.gateway.list pointt.gateway.users pointt.gateway.resource.dashapp pointt.castt.flow.token-exchange bacon',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      style_id: 'tt_bsch',
    });

    const startResult = await followRedirects(authUrl);
    if (startResult.type === 'deeplink') {
      // Already authenticated (shouldn't happen on fresh session, but handle it)
      return PointtClient.exchangeCode(PointtClient.extractCode(startResult.url));
    }

    const loginPageUrl = startResult.url;
    const loginHtml = startResult.body;

    if (!loginHtml || startResult.status !== 200) {
      throw new Error(`Could not load login page (HTTP ${startResult.status})`);
    }

    // — Step 2: Parse the login form —
    const attr = (tag, name) => {
      const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(tag);
      return m ? m[1].replace(/&amp;/g, '&').replace(/&#x2F;/g, '/') : null;
    };

    // Form action
    const formTagMatch = /<form[^>]+method="post"[^>]*>/i.exec(loginHtml) ||
                         /<form[^>]+>/i.exec(loginHtml);
    const rawAction = formTagMatch ? attr(formTagMatch[0], 'action') : null;
    const postUrl = rawAction
      ? (rawAction.startsWith('http') ? rawAction : `https://${TOKEN_HOST}${rawAction}`)
      : loginPageUrl;

    // All hidden inputs (ReturnUrl, __RequestVerificationToken, etc.)
    const hiddenFields = {};
    for (const m of loginHtml.matchAll(/<input[^>]+type="hidden"[^>]*/gi)) {
      const tag = m[0];
      const name = attr(tag, 'name');
      const value = attr(tag, 'value') ?? '';
      if (name) hiddenFields[name] = value;
    }

    // Email / username field name
    const emailInputMatch = loginHtml.match(/<input[^>]+type="(?:email|text)"[^>]*/i);
    const emailField = (emailInputMatch && attr(emailInputMatch[0], 'name')) || 'Input.Email';

    // Password field name
    const pwdInputMatch = loginHtml.match(/<input[^>]+type="password"[^>]*/i);
    const pwdField = (pwdInputMatch && attr(pwdInputMatch[0], 'name')) || 'Input.Password';

    // Helper: POST the password to the step 2 page, follow to deep-link
    const handlePasswordPage = async (html, currentUrl) => {
      // The page uses HTMX — the form might not be in the initial GET response.
      // Try fetching the partial via an HTMX request to get the actual form HTML.
      let formHtml = html;
      try {
        const htmxRes = await rawRequest('GET', currentUrl, {
          'HX-Request': 'true',
          'HX-Current-URL': currentUrl,
          'HX-Target': 'body',
          'HX-Boosted': 'true',
        }, null);
        if (htmxRes.status === 200 && htmxRes.body.length > 50) {
          console.log(`[PointtAuth] HTMX partial fetched (${htmxRes.body.length} bytes), snippet: ${htmxRes.body.slice(0, 200)}`);
          formHtml = htmxRes.body;
        }
      } catch (_) { /* fall back to initial body */ }

      // Parse form action and hidden fields from whichever HTML we have
      const attrQ = (tag, name) => {
        // matches both "value" and 'value'
        const m = new RegExp(`${name}=["']([^"']*)["']`, 'i').exec(tag);
        return m ? m[1].replace(/&amp;/g, '&').replace(/&#x2F;/g, '/') : null;
      };
      const formTag2 = /<form[^>]+method="post"[^>]*>/i.exec(formHtml) ||
                       /<form[^>]+>/i.exec(formHtml);
      const action2 = formTag2 ? attrQ(formTag2[0], 'action') : null;
      const step2PostUrl = action2
        ? (action2.startsWith('http') ? action2 : `https://${TOKEN_HOST}${action2}`)
        : currentUrl;

      const step2Hidden = {};
      for (const m of formHtml.matchAll(/<input[^>]+type=["']?hidden["']?[^>]*/gi)) {
        const tag = m[0];
        const name = attrQ(tag, 'name');
        const value = attrQ(tag, 'value') ?? '';
        if (name) step2Hidden[name] = value;
      }

      // Find password field — try both quote styles; fall back to known field name
      const pwdMatch = formHtml.match(/<input[^>]+type=["']?password["']?[^>]*/i);
      const step2PwdField = (pwdMatch && attrQ(pwdMatch[0], 'name')) || 'Input.Password';

      console.log(`[PointtAuth] Step 2 POST → ${step2PostUrl.slice(0, 100)} pwdField="${step2PwdField}" hidden=${JSON.stringify(Object.keys(step2Hidden))}`);
      const step2Body = querystring.stringify({ ...step2Hidden, [step2PwdField]: password, button: 'login' });
      const step2Res = await rawRequest('POST', step2PostUrl, {}, step2Body);
      console.log(`[PointtAuth] Step 2 response: status=${step2Res.status} location=${step2Res.headers.location ? step2Res.headers.location.slice(0, 100) : 'none'}`);

      if (step2Res.status >= 300 && step2Res.status < 400 && step2Res.headers.location) {
        const loc2 = step2Res.headers.location;
        if (loc2.startsWith('com.bosch.tt.dashtt.pointt://')) {
          return PointtClient.exchangeCode(PointtClient.extractCode(loc2));
        }
        const next2 = loc2.startsWith('http') ? loc2 : `https://${TOKEN_HOST}${loc2}`;
        const r2 = await followRedirects(next2);
        if (r2.type === 'deeplink') return PointtClient.exchangeCode(PointtClient.extractCode(r2.url));
        console.log(`[PointtAuth] Step 2 unexpectedly landed on page: ${r2.url.slice(0, 100)}`);
      }
      const b2 = (step2Res.body || '').toLowerCase();
      if (b2.includes('invalid') || b2.includes('incorrect') || b2.includes('ogiltigt') || b2.includes('wrong')) {
        throw new Error('Wrong password — please try again.');
      }
      throw new Error(`Login did not complete after password step. HTTP ${step2Res.status}`);
    };

    // — Step 3: POST step 1 (email identifier) —
    // Only send the email field + hidden fields in step 1 (server ignores password at this stage)
    const step1Body = querystring.stringify({
      ...hiddenFields,
      [emailField]: email,
      button: 'login',
    });

    console.log(`[PointtAuth] Step 1 POST ${postUrl.slice(0, 120)}`);
    console.log(`[PointtAuth] email field="${emailField}" hidden=${JSON.stringify(Object.keys(hiddenFields))}`);
    const postRes = await rawRequest('POST', postUrl, {}, step1Body);
    console.log(`[PointtAuth] Step 1 response: status=${postRes.status} location=${postRes.headers.location ? postRes.headers.location.slice(0, 120) : 'none'}`);

    if (postRes.status >= 300 && postRes.status < 400 && postRes.headers.location) {
      const loc = postRes.headers.location;
      if (loc.startsWith('com.bosch.tt.dashtt.pointt://')) {
        return PointtClient.exchangeCode(PointtClient.extractCode(loc));
      }
      const nextUrl = loc.startsWith('http') ? loc : `https://${TOKEN_HOST}${loc}`;
      const result = await followRedirects(nextUrl);
      if (result.type === 'deeplink') {
        return PointtClient.exchangeCode(PointtClient.extractCode(result.url));
      }
      // Landed on password page (step 2).
      // Detect by URL pattern (reliable) OR body content (fallback).
      // The server redirects to /en-gb/login?Current=%5B...%5D&returnUrl=... for step 2.
      const isPasswordStep = result.url.includes('Current=') ||
                             result.body.match(/type=["']?password["']?/i);
      if (result.type === 'page' && isPasswordStep) {
        return handlePasswordPage(result.body, result.url);
      }
      const b = result.body.toLowerCase();
      if (b.includes('invalid') || b.includes('incorrect') || b.includes('ogiltigt')) {
        throw new Error('Wrong email — please try again.');
      }
      throw new Error(`Login stalled after step 1. Landed on: ${result.url.slice(0, 80)}`);
    }

    // HTTP 200 on step 1 POST = email form returned (unusual) or single-step form
    if (postRes.status === 200) {
      const b = postRes.body.toLowerCase();
      if (b.includes('invalid') || b.includes('incorrect') || b.includes('ogiltigt')) {
        throw new Error('Wrong email — please try again.');
      }
      if (postRes.body.includes('type="password"')) {
        return handlePasswordPage(postRes.body, postUrl);
      }
      throw new Error('Login did not advance past the email step.');
    }

    throw new Error(`Unexpected login response: HTTP ${postRes.status}`);
  }

  static async exchangeCode(code) {
    const body = querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });

    const client = new PointtClient({ deviceId: '', accessToken: '', refreshToken: '', tokenExpiresAt: 0 });
    const data = await client._httpsPost(TOKEN_HOST, TOKEN_PATH, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: Date.now() + (data.expires_in * 1000),
    };
  }

}

module.exports = PointtClient;
