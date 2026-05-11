'use strict';

const Homey = require('homey');
const Device = require('./device');

class HeatPumpDriver extends Homey.Driver {

  // Pairing
  onPair(session) {
    this.log('Pairing started');
    session.setHandler('validate_device', async (data) => {
      const pairingDevice = {
        name: 'IVT Heat pump',
        data: {
          id: data.serial,
        },
        settings: {
          interval: data.interval,
          serial: data.serial,
          key: data.key,
          password: data.password,
        },
      };

      try {
        await this.validateDevice(pairingDevice);
        return pairingDevice;
      } catch (err) {
        this.log(`There was an error: ${err}`);
        return Promise.reject(err);
      }
    });
  }

  async validateDevice(data) {
    const key = data.settings.key || '';
    const pwd = data.settings.password || '';
    this.log(`Validating device: serial=${data.settings.serial}`);
    this.log(`  key length=${key.length}, key (no dashes)=${key.replace(/-/g,'').slice(0,6)}...`);
    this.log(`  password length=${pwd.length}, password starts=${pwd.slice(0,2)}...`);

    // Check and see if we can connect to the backend with the supplied credentials.
    let client;
    try {
      client = await Device.prototype.getClient.call(this, data.settings);
      this.log('XMPP client connected successfully');
    } catch (e) {
      this.log('unable to instantiate client:', e.message, e.stack);
      throw new Error(e);
    }

    let device;
    // Check for duplicate.
    try {
      device = this.getDevice(data.data);
    } catch (err) {
      // Device does not exist, hooray!
    }

    if (device instanceof Homey.Device) {
      this.log('device is already registered');
      client.end();
      throw new Error('Device is already registered');
    }

    // Retrieve status to see if we can successfully load data from backend.
    try {
      this.log('Fetching /heatingCircuits/hc1/roomtemperature to validate...');
      const res = await client.get('/heatingCircuits/hc1/roomtemperature');
      this.log('Validation response:', JSON.stringify(res));
    } catch (e) {
      this.log('Validation fetch failed:', e.message);
      this.log('Error details:', JSON.stringify({
        name: e.name,
        message: e.message,
        statusCode: e.statusCode || e.response?.statusCode,
        body: e.response?.body,
        stack: e.stack,
      }));
      if (e instanceof SyntaxError) {
        this.log('invalid credentials');
        throw new Error('Invalid credentials');
      }
      throw new Error(e.message);
    } finally {
      client.end();
    }

    // Everything checks out.
    return true;
  }

}

module.exports = HeatPumpDriver;
