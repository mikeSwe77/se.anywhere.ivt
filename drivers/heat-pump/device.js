'use strict';

const { Device } = require('homey');
const { IVTClient } = require('../../lib/bosch-xmpp');
const Capabilities = require('../../lib/capabilities');
const ErrorCodes = require('../../lib/errorcodes');

class HeatPumpDevice extends Device {

  async onInit() {
    try {
      this.client = await this.getClient(this.getSettings());
    } catch (e) {
      this.log(`Unable to initialize device: ${e.message}`);
      throw e;
    }

    const updateInterval = Number(this.getSetting('interval')) * 1000;
    this.data = this.getData();
    this.isWriting = false; // Flag to pause polling during writes

    // Register capability listener for Target Temperature
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));

    this.log(`[${this.getName()}][${this.data.id}]`, `Update Interval: ${updateInterval}`);
    this.log(`[${this.getName()}][${this.data.id}]`, 'Connected to device');
    
    // Start polling loop
    this.interval = setInterval(async () => {
      if (!this.isWriting) {
        await this.getDeviceData();
      }
    }, updateInterval);

    this.log('IVT heat pump device has been initialized');
  }

  async onCapabilityTargetTemperature(value) {
    this.isWriting = true;
    const endpoint = '/heatingCircuits/hc1/temperatureRoomSetpoint';
    const payload = { value: parseFloat(value) };

    try {
      if (this.client && typeof this.client.put === 'function') {
        await this.client.put(endpoint, payload);
        return Promise.resolve();
      } else {
        throw new Error('Client does not support "put" command or is not connected.');
      }
    } catch (err) {
      this.log('Failed to set target temperature:', err);
      return Promise.reject(err);
    } finally {
      this.isWriting = false;
    }
  }

  async getDeviceData() {
    const energyMonitoringCapabilities = [
      'LAST_HOUR_POWER_TOTAL',
      'LAST_HOUR_POWER_EHEATER',
      'LAST_HOUR_POWER_COMPRESSOR',
    ];

    for (const [key, value] of Object.entries(Capabilities)) {
      if (this.isWriting) break; // Stop polling if a write is in progress

      try {
        let result;
        const endpoint = energyMonitoringCapabilities.includes(key)
          ? value.endpoint + new Date().toISOString().split('T')[0]
          : value.endpoint;

        const res = await this.client.get(endpoint);

        if (energyMonitoringCapabilities.includes(key)) {
          const currentHour = new Date().getHours();
          // -2 logic preserved from original code (likely due to timezones or API delay)
          const currentHourObject = res.recording[currentHour - 2];
          result = currentHourObject.y / currentHourObject.c;
        } else {
          result = res.value;
        }

        this.updateValue(value.name, result);
      } catch (err) {
        // Suppress poll errors to keep logs clean
      }
    }
  }

  updateValue(capability, value) {
    // Alarm logic
    if (capability === 'alarm_status') {
      value = value !== 'ok';
      if (this.getCapabilityValue(capability) !== value) {
        this.triggerAlarmStatusChange(value);
      }
    }

    // Only update Homey if the value actually changed
    if (this.getCapabilityValue(capability) !== value) {
        this.log(`Setting capability [${capability}] value to: ${value}`);
        this.setCapabilityValue(capability, value).catch(this.error);
    }
  }

  async triggerAlarmStatusChange(value) {
    if (value) {
      try {
        const res = await this.client.get('/notifications');
        const tokens = {
          code: res.values.map((obj) => obj.ccd).join(', '),
          description: res.values
            .map((obj) => `${obj.ccd}: ${ErrorCodes[obj.ccd].description}`)
            .join(', '),
        };

        this.log('Alarm status has changed to error. Trigger ERROR card..');
        await this.homey.flow.getDeviceTriggerCard('alarm_status_error')
          .trigger(this, tokens);
      } catch (error) {
        this.log(error);
      }
    } else if (this.getCapabilityValue('alarm_status') === 'error') {
      this.log('Alarm status has changed to OK. Trigger OK card.');
      this.homey.flow.getDeviceTriggerCard('alarm_status_ok').trigger(this)
        .catch(this.error);
    }
  }

  async onAdded() {
    this.log('Device added');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    const { interval } = this;
    if (oldSettings.interval !== newSettings.interval) {
      clearInterval(interval);
      this.setUpdateInterval(newSettings.interval);
    }
  }

  async getClient(settings) {
    const client = IVTClient({
      serialNumber: settings.serial,
      accessKey: settings.key,
      password: settings.password,
      retryTimeout: 10000, 
      maxRetries: 5
    });

    // --- CRITICAL FIX: OVERRIDE PUT METHOD ---
    // The library defaults to single newline (\n) for PUT requests,
    // but IVT heat pumps require double newlines (\n\n) to parse the headers.
    client.put = function(uri, data) {
        const encrypted = this.encrypt(typeof data === 'string' ? data : JSON.stringify(data));
        const separator = '\n\n'; // Force double newline
        const message = this.buildMessage([
          `PUT ${ uri } HTTP/1.1`,
          `User-Agent: ${ this.USERAGENT }`,
          `Content-Type: application/json`,
          `Content-Length: ${ encrypted.length }`,
          `Seq-No: ${ this.seqno++ }`,
          ``,
          encrypted
        ].join(separator));

        return this.send(message).then(response => {
          const status = Number(response.statusCode || 500);
          if (status >= 300) {
            const error = new Error('INVALID_RESPONSE');
            error.response = response;
            throw error;
          } else if (status === 204) {
            response.body = null;
          }
          return response.body || { status : 'ok' };
        });
    };
    // -----------------------------------------

    await client.connect();
    this.log('Device connected successfully to backend');
    return client;
  }

  async onDeleted() {
    const { interval } = this;
    if (this.client) {
      this.client.end();
    }
    clearInterval(interval);
  }
}

module.exports = HeatPumpDevice;