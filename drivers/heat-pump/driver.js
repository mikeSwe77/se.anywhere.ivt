'use strict';

const Homey = require('homey');
const PointtClient = require('../../lib/pointt-client');

class HeatPumpDriver extends Homey.Driver {

  onPair(session) {
    this.log('Pairing started');

    session.setHandler('authenticate', async ({ email, password, serial, interval }) => {
      this.log(`authenticate: serial=${serial}, interval=${interval}, email=${email}`);

      // Full headless OAuth flow — no browser popup needed
      let tokens;
      try {
        tokens = await PointtClient.authenticate(email, password);
        this.log('Authentication successful, token expires:', new Date(tokens.token_expires_at).toISOString());
      } catch (err) {
        this.log('Authentication failed:', err.message);
        throw new Error(err.message);
      }

      // Validate by fetching a live endpoint for this specific device (serial)
      const client = new PointtClient({
        deviceId: serial,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.token_expires_at,
      });

      try {
        this.log('Validating device serial against Pointt API...');
        await client.get('/heatingCircuits/hc1/roomtemperature');
        this.log('Device validation successful');
      } catch (err) {
        this.log('Device validation failed:', err.message, 'statusCode:', err.statusCode);
        if (err.statusCode === 404) throw new Error('Heat pump not found. Check the serial number.');
        if (err.statusCode === 401 || err.statusCode === 403) throw new Error('Authorization failed for this device.');
        throw new Error(`Could not reach heat pump: ${err.message}`);
      }

      // Check for duplicate
      let existing;
      try { existing = this.getDevice({ id: serial }); } catch (_) { /* does not exist — good */ }
      if (existing instanceof Homey.Device) throw new Error('This heat pump is already added.');

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

    session.setHandler('authenticate', async ({ email, password }) => {
      let tokens;
      try {
        tokens = await PointtClient.authenticate(email, password);
      } catch (err) {
        throw new Error(err.message);
      }

      await device.setStoreValue('access_token', tokens.access_token);
      await device.setStoreValue('refresh_token', tokens.refresh_token);
      await device.setStoreValue('token_expires_at', tokens.token_expires_at);

      device.reinitClient(tokens);
      this.log('Repair successful — tokens updated');
      return true;
    });
  }

}

module.exports = HeatPumpDriver;
