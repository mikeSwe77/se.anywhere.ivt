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
          interval: Number(data.interval) || 60,
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

  onRepair(session, device) {
    this.log('Repair started for device:', device.getData().id);
    session.setHandler('validate_device', async (data) => {
      const newSettings = {
        interval: Number(data.interval) || Number(device.getSetting('interval')) || 60,
        serial: data.serial,
        key: data.key,
        password: data.password,
      };

      // Validate credentials by connecting
      const tempDevice = { data: device.getData(), settings: newSettings };
      try {
        await this.validateDevice(tempDevice);
      } catch (err) {
        this.log(`Repair validation failed: ${err}`);
        return Promise.reject(err);
      }

      // Apply new settings and reconnect
      await device.onSettings({ oldSettings: device.getSettings(), newSettings, changedKeys: Object.keys(newSettings) });
      this.log('Repair successful');
      return true;
    });
  }

  async validateDevice(data) {
    let client;
    try {
      client = await Device.prototype.getClient.call(this, data.settings);
    } catch (e) {
      this.log('unable to instantiate client:', e.message);
      throw new Error(e);
    }

    // Check for duplicate.
    let device;
    try {
      device = this.getDevice(data.data);
    } catch (err) {
      // Device does not exist — good
    }

    if (device instanceof Homey.Device) {
      this.log('device is already registered');
      client.end();
      throw new Error('Device is already registered');
    }

    // Retrieve firmware version to validate credentials
    try {
      await client.get('/gateway/versionFirmware');
    } catch (e) {
      if (e instanceof SyntaxError) {
        this.log('invalid credentials');
        throw new Error('Invalid credentials');
      }
      throw new Error(e.message);
    } finally {
      client.end();
    }

    return true;
  }

}

module.exports = HeatPumpDriver;
