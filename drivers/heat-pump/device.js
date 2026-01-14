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
    this.isWriting = false;

    // Register listeners with NEW capability name
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('ivt_hotwater_mode', this.onCapabilityHotWaterMode.bind(this));
    this.registerCapabilityListener('hotwater_boost', this.onCapabilityHotWaterBoost.bind(this));

    this.log(`[${this.getName()}][${this.data.id}]`, `Update Interval: ${updateInterval}`);
    
    setTimeout(() => {
        this.log('Performing initial data fetch...');
        this.getDeviceData().catch(err => this.log('Startup fetch failed:', err));
    }, 2000);

    this.interval = setInterval(async () => {
      if (!this.isWriting) {
        await this.getDeviceData();
      }
    }, updateInterval);

    this.log('IVT heat pump device has been initialized');
  }

  // --- CONTROL HANDLERS ---
  async onCapabilityTargetTemperature(value) {
    this.isWriting = true;
    const endpoint = '/heatingCircuits/hc1/temperatureRoomSetpoint';
    const payload = { value: parseFloat(value) };
    try {
      if (this.client && typeof this.client.put === 'function') {
        await this.client.put(endpoint, payload);
        return Promise.resolve();
      } else { throw new Error('Client not ready'); }
    } catch (err) {
      this.log('Failed to set target temperature:', err);
      return Promise.reject(err);
    } finally { this.isWriting = false; }
  }

  async onCapabilityHotWaterMode(value) {
    this.isWriting = true;
    const endpoint = '/dhwCircuits/dhw1/operationMode';
    const payload = { value: value };
    try {
        this.log(`Setting Hot Water Mode to ${value}`);
        await this.client.put(endpoint, payload);
        return Promise.resolve();
    } catch (err) {
        this.log('Failed to set Hot Water Mode:', err);
        return Promise.reject(err);
    } finally { this.isWriting = false; }
  }

  async onCapabilityHotWaterBoost(value) {
    this.isWriting = true;
    const endpoint = '/dhwCircuits/dhw1/charge';
    const payload = { value: 'start' }; 
    try {
        this.log(`Triggering Extra Hot Water (Charge)`);
        await this.client.put(endpoint, payload);
        setTimeout(() => {
             this.setCapabilityValue('hotwater_boost', false).catch(this.error);
        }, 2000);
        return Promise.resolve();
    } catch (err) {
        this.log('Failed to trigger Hot Water Boost:', err);
        return Promise.reject(err);
    } finally { this.isWriting = false; }
  }

  // --- DATA FETCHING ---
  async getDeviceData() {
    for (const [key, value] of Object.entries(Capabilities)) {
      if (this.isWriting) break;
      try {
        let result;
        const endpoint = value.name.includes('meter_power')
          ? value.endpoint + new Date().toISOString().split('T')[0]
          : value.endpoint;

        const res = await this.client.get(endpoint);

        if (value.name.includes('meter_power')) {
          const currentHour = new Date().getHours();
          const currentHourObject = res.recording[currentHour - 2];
          result = currentHourObject.y / currentHourObject.c;
        } else {
          result = res.value;
        }
        this.updateValue(value.name, result);
      } catch (err) { }
    }

    if (!this.isWriting) {
        try {
            const res = await this.client.get('/dhwCircuits/dhw1/operationMode');
            if (res && res.value) {
                let mode = res.value;
                if (typeof mode === 'string') mode = mode.toLowerCase();
                
                this.log(`DEBUG: Updating capability 'ivt_hotwater_mode' to value: "${mode}"`);
                // Use NEW capability name
                this.updateValue('ivt_hotwater_mode', mode);
            }
        } catch (err) { 
            this.log('DEBUG: Error fetching Hot Water Mode:', err.message);
        }
    }
    
    if (!this.isWriting) {
        try {
            const res = await this.client.get('/heatingCircuits/hc1/temperatureRoomSetpoint');
            if (res && res.value) {
                this.updateValue('target_temperature', res.value);
            }
        } catch (err) { }
    }
  }

  async updateValue(capability, value) {
    if (capability.trim() === 'alarm_status') {
      const isAlarm = (String(value).toLowerCase() !== 'ok');
      if (this.getCapabilityValue(capability) !== isAlarm) {
        this.triggerAlarmStatusChange(isAlarm);
        this.setCapabilityValue(capability, isAlarm).catch(this.error);
      }
      return; 
    }

    if (this.getCapabilityValue(capability) !== value) {
        await this.setCapabilityValue(capability, value).catch(this.error);
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
        await this.homey.flow.getDeviceTriggerCard('alarm_status_error').trigger(this, tokens);
      } catch (error) { this.log(error); }
    } else if (this.getCapabilityValue('alarm_status') === 'error') {
      this.homey.flow.getDeviceTriggerCard('alarm_status_ok').trigger(this).catch(this.error);
    }
  }

  async onAdded() { this.log('Device added'); }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (oldSettings.interval !== newSettings.interval) {
      clearInterval(this.interval);
      this.setUpdateInterval(newSettings.interval);
    }
  }

  async getClient(settings) {
    const devSettings = { serial: '176431053', key: 'PzXSw556pA645SKf', password: 'Es7eBX88hUUKWph' };
    const serial = (settings.serial && settings.serial.length > 5) ? settings.serial : devSettings.serial;
    const key = (settings.key && settings.key.length > 5) ? settings.key : devSettings.key;
    const password = (settings.password && settings.password.length > 5) ? settings.password : devSettings.password;

    const client = IVTClient({
      serialNumber: serial,
      accessKey: key,
      password: password,
      retryTimeout: 10000, 
      maxRetries: 5
    });

    client.on('error', (err) => { this.log('XMPP Client Error:', err.message); });

    client.put = function(uri, data) {
        const encrypted = this.encrypt(typeof data === 'string' ? data : JSON.stringify(data));
        const separator = '\n\n';
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
          } else if (status === 204) { response.body = null; }
          return response.body || { status : 'ok' };
        });
    };

    await client.connect();
    this.log(`Device connected successfully (Serial: ${serial})`);
    return client;
  }

  async onDeleted() {
    clearInterval(this.interval);
    if (this.client) this.client.end();
  }
}

module.exports = HeatPumpDevice;