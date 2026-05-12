'use strict';

const Homey = require('homey');
const PointtClient = require('../../lib/pointt-client');

class HeatPumpDriver extends Homey.Driver {

  onPair(session) {
    this.log('Pairing started');

    session.setHandler('get_auth_url', async () => {
      const url = PointtClient.buildAuthUrl();
      this.log('Auth URL built:', url.slice(0, 80) + '...');
      return url;
    });

    session.setHandler('exchange_code', async ({ callbackUrl, serial, interval }) => {
      this.log(`exchange_code: serial=${serial}, interval=${interval}`);

      // Extract code — handles both the deep link and the singlekey-id.com redirection page URL
      let code;
      try {
        if (callbackUrl.includes('singlekey-id.com')) {
          // Safari desktop: user copied the intermediate redirection page URL.
          // Complete the OAuth callback server-side by following the redirect chain.
          this.log('Detected singlekey-id redirection URL — completing callback server-side');
          code = await PointtClient.completeViaRedirectionUrl(callbackUrl);
        } else {
          // Direct deep link (com.bosch.tt.dashtt.pointt://...) — from iOS or another browser
          code = PointtClient.extractCode(callbackUrl);
        }
        this.log('Authorization code obtained, length:', code.length);
      } catch (err) {
        this.log('Code extraction failed:', err.message);
        throw new Error(`Could not get authorization code: ${err.message}`);
      }

      // Exchange code for tokens
      let tokens;
      try {
        tokens = await PointtClient.exchangeCode(code);
        this.log('Token exchange successful, expires_at:', new Date(tokens.token_expires_at).toISOString());
      } catch (err) {
        this.log('Token exchange failed:', err.message, err.body || '');
        throw new Error(`Login failed: ${err.message}`);
      }

      // Validate by fetching a live endpoint
      const client = new PointtClient({
        deviceId: serial,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.token_expires_at,
      });

      try {
        this.log('Validating credentials against Pointt API...');
        await client.get('/heatingCircuits/hc1/roomtemperature');
        this.log('Validation successful');
      } catch (err) {
        this.log('Validation failed:', err.message, 'statusCode:', err.statusCode);
        if (err.statusCode === 404) {
          throw new Error('Device not found. Check the serial number.');
        }
        if (err.statusCode === 401 || err.statusCode === 403) {
          throw new Error('Authorization failed. Please log in again.');
        }
        throw new Error(`Could not connect to heat pump: ${err.message}`);
      }

      // Check for duplicate
      let existing;
      try {
        existing = this.getDevice({ id: serial });
      } catch (_) { /* device does not exist — good */ }

      if (existing instanceof Homey.Device) {
        this.log('Device already registered');
        throw new Error('This heat pump is already added.');
      }

      return {
        name: 'IVT Heat pump',
        data: { id: serial },
        store: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: tokens.token_expires_at,
        },
        settings: {
          deviceId: serial,
          interval: Number(interval) || 60,
        },
      };
    });
  }

  onRepair(session, device) {
    this.log('Repair started for device:', device.getData().id);

    session.setHandler('get_auth_url', async () => {
      return PointtClient.buildAuthUrl();
    });

    session.setHandler('exchange_code', async ({ callbackUrl }) => {
      let code;
      try {
        if (callbackUrl.includes('singlekey-id.com')) {
          code = await PointtClient.completeViaRedirectionUrl(callbackUrl);
        } else {
          code = PointtClient.extractCode(callbackUrl);
        }
      } catch (err) {
        throw new Error(`Could not get authorization code: ${err.message}`);
      }

      let tokens;
      try {
        tokens = await PointtClient.exchangeCode(code);
      } catch (err) {
        throw new Error(`Login failed: ${err.message}`);
      }

      // Save new tokens to device store
      await device.setStoreValue('access_token', tokens.access_token);
      await device.setStoreValue('refresh_token', tokens.refresh_token);
      await device.setStoreValue('token_expires_at', tokens.token_expires_at);

      // Re-initialize the client on the device with new tokens
      device.reinitClient(tokens);

      this.log('Repair successful — tokens updated');
      return true;
    });
  }

}

module.exports = HeatPumpDriver;
