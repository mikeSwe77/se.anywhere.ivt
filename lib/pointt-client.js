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

    return `https://${TOKEN_HOST}/auth/en-us/login?${params}`;
  }

  static extractCode(callbackUrl) {
    // Accepts full URL or just query string
    const match = callbackUrl.match(/[?&]code=([^&]+)/);
    if (!match) throw new Error('No authorization code found in callback URL');
    return decodeURIComponent(match[1]);
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
