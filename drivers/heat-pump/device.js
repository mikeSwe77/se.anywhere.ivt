'use strict';

const { Device } = require('homey');
const { IVTClient } = require('../../lib/bosch-xmpp');
const Capabilities = require('../../lib/capabilities');
const ErrorCodes = require('../../lib/errorcodes');

class HeatPumpDevice extends Device {

  async onInit() {
    this.data = this.getData();
    this.isWriting = false;

    // Add capabilities introduced after initial pairing
    for (const cap of ['compressor_active', 'pump_modulation', 'measure_temperature.water_setpoint']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    // Initialize the client using user settings
    try {
      this.client = await this.getClient(this.getSettings());
    } catch (e) {
      this.error(`Unable to initialize device: ${e.message}`);
      this.setUnavailable(e.message).catch(this.error);
    }

    // Register Capability Listeners
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('ivt_hotwater_mode', this.onCapabilityHotWaterMode.bind(this));
    this.registerCapabilityListener('hotwater_boost', this.onCapabilityHotWaterBoost.bind(this));

    // Setup Polling
    const updateInterval = Number(this.getSetting('interval')) * 1000;
    this.log(`[${this.getName()}] Update Interval: ${updateInterval}ms`);

    // Initial Data Fetch (Delayed 2s to ensure SSL stability)
    setTimeout(() => {
        this.getDeviceData().catch(err => this.error('Startup fetch failed:', err));
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
      this.error('Failed to set target temperature:', err);
      return Promise.reject(err);
    } finally { this.isWriting = false; }
  }

  async onCapabilityHotWaterMode(value) {
    this.isWriting = true;
    const endpoint = '/dhwCircuits/dhw1/operationMode';
    const payload = { value: value };
    try {
      if (this.client && typeof this.client.put === 'function') {
        await this.client.put(endpoint, payload);
        return Promise.resolve();
      } else { throw new Error('Client not ready'); }
    } catch (err) {
      this.error('Failed to set Hot Water Mode:', err);
      return Promise.reject(err);
    } finally { this.isWriting = false; }
  }

  async onCapabilityHotWaterBoost(value) {
    if (!value) return;
    this.isWriting = true;
    const endpoint = '/dhwCircuits/dhw1/charge';
    const payload = { value: 'start' };
    try {
      if (this.client && typeof this.client.put === 'function') {
        await this.client.put(endpoint, payload);
        setTimeout(() => {
          this.setCapabilityValue('hotwater_boost', false).catch(this.error);
        }, 2000);
        return Promise.resolve();
      } else { throw new Error('Client not ready'); }
    } catch (err) {
      this.error('Failed to trigger Hot Water Boost:', err);
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
          const idx = Math.max(0, currentHour - 2);  
          const currentHourObject = res.recording?.[idx];  
          if (!currentHourObject || !currentHourObject.c) { continue; }  
          result = currentHourObject.y / currentHourObject.c;  

        } else {
          result = res.value;
          // Ensure Number type for temperatures to support Thermostat Dial
          if (typeof result === 'string' && !isNaN(result)) {
             result = parseFloat(result);
          }
        }
        this.updateValue(value.name, result);
      } catch (err) { this.log(`Failed to fetch ${value.name}:`, err.message); }
    }

    if (!this.isWriting) {
      try {
        const res = await this.client.get('/dhwCircuits/dhw1/operationMode');
        if (res && res.value) {
          let mode = res.value;
          if (typeof mode === 'string') mode = mode.toLowerCase();
          this.updateValue('ivt_hotwater_mode', mode);
        }
      } catch (err) { this.log('Failed to fetch ivt_hotwater_mode:', err.message); }
    }

    if (!this.isWriting) {
      try {
        const res = await this.client.get('/heatingCircuits/hc1/temperatureRoomSetpoint');
        if (res && res.value) {
          this.updateValue('target_temperature', parseFloat(res.value));
        }
      } catch (err) { this.log('Failed to fetch target_temperature:', err.message); }
    }

    if (!this.isWriting) {
      try {
        const res = await this.client.get('/heatSources/flameStatus');
        if (res && res.value !== undefined) {
          this.updateValue('compressor_active', res.value === 'on');
        }
      } catch (err) { this.log('Failed to fetch compressor_active:', err.message); }
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
            .map((obj) => `${obj.ccd}: ${ErrorCodes[obj.ccd]?.description ?? 'Unknown error'}`)
            .join(', '),
        };
        await this.homey.flow.getDeviceTriggerCard('alarm_status_error').trigger(this, tokens);
      } catch (error) { this.error(error); }
    } else if (this.getCapabilityValue('alarm_status') === true) {  
      this.homey.flow.getDeviceTriggerCard('alarm_status_ok').trigger(this).catch(this.error);  
    }
  }

  async onAdded() { this.log('Device added'); }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (oldSettings.interval !== newSettings.interval) {
      clearInterval(this.interval);
      this.interval = setInterval(async () => {
        if (!this.isWriting) {
          await this.getDeviceData();
        }
      }, newSettings.interval * 1000);
    }

    // Reconnect if credentials changed
    if (oldSettings.serial !== newSettings.serial || oldSettings.key !== newSettings.key || oldSettings.password !== newSettings.password) {
      if (this.client) this.client.end();
      this.client = await this.getClient(newSettings);
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

    client.on('error', (err) => { 
        // Log basic error message but prevent app crash
        this.error('XMPP Client Error:', err.message); 
    });

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
    this.log(`Device connected`);
    return client;
  }

  async onDeleted() {
    clearInterval(this.interval);
    if (this.client) this.client.end();
  }
}

module.exports = HeatPumpDevice;