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
   * Called when the user pastes the intermediate redirection page URL:
   *   https://singlekey-id.com/sv-se/redirection?returnUrl=/auth/connect/authorize/callback?...&f=XXXX
   *
   * Safari can't open the final deep-link redirect, so we complete the
   * callback ourselves: follow the redirect chain from the callback endpoint
   * until we get a Location pointing to com.bosch.tt.dashtt.pointt://...
   * then extract the code from that URL.
   */
  static async completeViaRedirectionUrl(redirectionUrl) {
    const parsed = new URL(redirectionUrl);
    const returnUrl = parsed.searchParams.get('returnUrl'); // already decoded
    const f = parsed.searchParams.get('f');

    if (!returnUrl) throw new Error('Invalid URL — no returnUrl found');

    // Append f to the callback path (IdentityServer uses it as the grant reference)
    const callbackPath = f ? `${returnUrl}&f=${encodeURIComponent(f)}` : returnUrl;
    const callbackFullUrl = `https://${TOKEN_HOST}${callbackPath}`;

    return PointtClient._followToDeepLink(callbackFullUrl, {}, 8);
  }

  /** Follow HTTP redirects until we see the app deep-link, then return the code. */
  static _followToDeepLink(url, cookies, remainingRedirects) {
    if (remainingRedirects <= 0) return Promise.reject(new Error('Too many redirects completing OAuth callback'));

    return new Promise((resolve, reject) => {
      let parsed;
      try { parsed = new URL(url); } catch (e) { return reject(new Error(`Bad redirect URL: ${url}`)); }

      const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible)',
          ...(cookieStr ? { Cookie: cookieStr } : {}),
        },
      };

      const req = https.request(options, (res) => {
        // Collect Set-Cookie headers
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          const list = Array.isArray(setCookie) ? setCookie : [setCookie];
          for (const c of list) {
            const [kv] = c.split(';');
            const eqIdx = kv.indexOf('=');
            if (eqIdx > 0) cookies[kv.slice(0, eqIdx).trim()] = kv.slice(eqIdx + 1).trim();
          }
        }

        const location = res.headers['location'];

        if (res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.resume(); // Drain body

          // 🎉 Found the app deep-link — extract the code
          if (location.startsWith('com.bosch.tt.dashtt.pointt://') ||
              location.startsWith('com.bosch.tt.dashtt.pointt%3A')) {
            try { resolve(PointtClient.extractCode(decodeURIComponent(location))); }
            catch (e) { reject(e); }
            return;
          }

          // Follow the next hop
          const nextUrl = location.startsWith('http') ? location : `https://${TOKEN_HOST}${location}`;
          PointtClient._followToDeepLink(nextUrl, cookies, remainingRedirects - 1)
            .then(resolve).catch(reject);
          return;
        }

        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          reject(new Error(
            `OAuth callback returned HTTP ${res.statusCode} (expected redirect). ` +
            `Response: ${body.slice(0, 300)}`
          ));
        });
      });

      req.on('error', reject);
      req.end();
    });
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
