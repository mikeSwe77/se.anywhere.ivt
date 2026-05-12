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

  static extractCode(callbackUrl) {
    // Accepts: deep link (com.bosch.tt.dashtt.pointt://...) or any URL with ?code=
    const match = callbackUrl.match(/[?&]code=([^&]+)/);
    if (!match) throw new Error('No authorization code found in callback URL');
    return decodeURIComponent(match[1]);
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

    // Follow HTTP redirects until we land on a page (200) or a deep-link (Location)
    const followRedirects = async (startUrl, maxHops = 8) => {
      let url = startUrl;
      for (let i = 0; i < maxHops; i++) {
        const res = await rawRequest('GET', url, {}, null);
        const loc = res.headers.location;
        if (res.status >= 300 && res.status < 400 && loc) {
          if (loc.startsWith('com.bosch.tt.dashtt.pointt://')) return { type: 'deeplink', url: loc };
          url = loc.startsWith('http') ? loc : `https://${TOKEN_HOST}${loc}`;
          continue;
        }
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

    // — Step 3: POST credentials —
    const formBody = querystring.stringify({
      ...hiddenFields,
      [emailField]: email,
      [pwdField]: password,
      button: 'login',
    });

    const postRes = await rawRequest('POST', postUrl, {}, formBody);

    // Successful login = server redirects us forward
    if (postRes.status >= 300 && postRes.status < 400 && postRes.headers.location) {
      const loc = postRes.headers.location;
      if (loc.startsWith('com.bosch.tt.dashtt.pointt://')) {
        return PointtClient.exchangeCode(PointtClient.extractCode(loc));
      }
      const nextUrl = loc.startsWith('http') ? loc : `https://${TOKEN_HOST}${loc}`;
      const redirectResult = await followRedirects(nextUrl);
      if (redirectResult.type === 'deeplink') {
        return PointtClient.exchangeCode(PointtClient.extractCode(redirectResult.url));
      }
      throw new Error('Login succeeded but no authorization code was received. Check serial number.');
    }

    // HTTP 200 on POST = login page returned again (wrong password, or 2-step flow)
    if (postRes.status === 200) {
      const b = postRes.body.toLowerCase();
      if (b.includes('invalid') || b.includes('incorrect') ||
          b.includes('ogiltigt') || b.includes('felaktigt') || b.includes('wrong')) {
        throw new Error('Wrong email or password — please try again.');
      }
      // May be a 2-step flow: first POST with just email, then password
      // Check if there's a password field in the response
      if (postRes.body.includes('type="password"')) {
        // We're on the password step — POST again with only password + hidden fields
        const step2Html = postRes.body;
        const step2Form = /<form[^>]+method="post"[^>]*>/i.exec(step2Html) ||
                          /<form[^>]+>/i.exec(step2Html);
        const step2Action = step2Form ? attr(step2Form[0], 'action') : null;
        const step2Url = step2Action
          ? (step2Action.startsWith('http') ? step2Action : `https://${TOKEN_HOST}${step2Action}`)
          : postUrl;
        const step2Hidden = {};
        for (const m of step2Html.matchAll(/<input[^>]+type="hidden"[^>]*/gi)) {
          const tag = m[0];
          const name = attr(tag, 'name');
          const value = attr(tag, 'value') ?? '';
          if (name) step2Hidden[name] = value;
        }
        const step2PwdMatch = step2Html.match(/<input[^>]+type="password"[^>]*/i);
        const step2PwdField = (step2PwdMatch && attr(step2PwdMatch[0], 'name')) || pwdField;
        const step2Body = querystring.stringify({ ...step2Hidden, [step2PwdField]: password, button: 'login' });
        const step2Res = await rawRequest('POST', step2Url, {}, step2Body);
        if (step2Res.status >= 300 && step2Res.status < 400 && step2Res.headers.location) {
          const loc = step2Res.headers.location;
          if (loc.startsWith('com.bosch.tt.dashtt.pointt://')) {
            return PointtClient.exchangeCode(PointtClient.extractCode(loc));
          }
          const nextUrl = loc.startsWith('http') ? loc : `https://${TOKEN_HOST}${loc}`;
          const r = await followRedirects(nextUrl);
          if (r.type === 'deeplink') return PointtClient.exchangeCode(PointtClient.extractCode(r.url));
        }
        throw new Error('Wrong email or password — please try again.');
      }
      throw new Error('Login did not complete. Please check your credentials.');
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
