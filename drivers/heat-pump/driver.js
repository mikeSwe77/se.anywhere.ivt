'use strict';

const Homey = require('homey');
const PointtClient = require('../../lib/pointt-client');

class HeatPumpDriver extends Homey.Driver {

  onPair(session) {
    this.log('Pairing started');

    session.setHandler('authenticate', async ({ email, password, serial, interval }) => {
      this.log(`authenticate: email=${email}, serial=${serial || '(auto)'}, interval=${interval}`);

      // Full headless OAuth flow — no browser popup needed
      let tokens;
      try {
        tokens = await PointtClient.authenticate(email, password);
        this.log('Authentication successful, token expires:', new Date(tokens.token_expires_at).toISOString());
      } catch (err) {
        this.log('Authentication failed:', err.message);
        throw new Error(err.message);
      }

      // Discover device ID — use provided serial or auto-discover from API
      let deviceId = serial ? String(serial).trim() : '';

      if (!deviceId) {
        try {
          this.log('No serial provided — querying gateway list from Pointt API...');
          const gateways = await PointtClient.listGateways(tokens.access_token);
          this.log('Gateways found:', JSON.stringify(gateways));
          if (!gateways.length) throw new Error('No heat pumps found on this account.');
          if (gateways.length === 1) {
            deviceId = gateways[0].id;
            this.log('Auto-selected device:', deviceId);
          } else {
            // Multiple — list them for the user
            const names = gateways.map(g => `${g.id} (${g.name})`).join(', ');
            throw new Error(`Multiple heat pumps found: ${names}. Please enter the serial number manually.`);
          }
        } catch (err) {
          if (err.message.includes('Multiple') || err.message.includes('No heat pumps')) throw err;
          this.log('Gateway list failed:', err.message);
          throw new Error(`Could not discover device. Please enter the serial number manually.`);
        }
      }

      // Validate the device is reachable
      const client = new PointtClient({
        deviceId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.token_expires_at,
      });

      try {
        this.log('Validating device', deviceId, 'against Pointt API...');
        await client.get('/heatingCircuits/hc1/roomtemperature');
        this.log('Device validation successful');
      } catch (err) {
        this.log('Device validation failed:', err.message, 'statusCode:', err.statusCode);
        if (err.statusCode === 404) throw new Error(`Heat pump ${deviceId} not found. Check the serial number.`);
        if (err.statusCode === 401 || err.statusCode === 403) throw new Error('Authorization failed. Please try again.');
        throw new Error(`Could not reach heat pump: ${err.message}`);
      }

      // Check for duplicate
      let existing;
      try { existing = this.getDevice({ id: deviceId }); } catch (_) { /* does not exist — good */ }
      if (existing instanceof Homey.Device) throw new Error('This heat pump is already added.');

      return {
        name: 'IVT Heat pump',
        data: { id: deviceId },
        store: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: tokens.token_expires_at,
        },
        settings: {
          deviceId,
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
