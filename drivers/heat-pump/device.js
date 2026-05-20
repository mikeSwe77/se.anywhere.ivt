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
    for (const cap of ['compressor_active', 'pump_modulation', 'measure_temperature.water_setpoint', 'meter_power', 'cop']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    // Connect to the XMPP backend.
    // Short delay so any pairing-validation connection (driver.js) has time
    // to fully close on the gateway side before we open a new one.
    await new Promise(r => setTimeout(r, 3000));
    try {
      this.client = await this.getClient(this.getSettings());
    } catch (e) {
      this.error(`Unable to initialize device: ${e.message}`);
      this.setUnavailable(e.message).catch(this.error);
      return;
    }

    const updateInterval = Number(this.getSetting('interval')) * 1000;
    this.log(`[${this.getName()}] Update Interval: ${updateInterval}ms`);

    // Register Capability Listeners
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('ivt_hotwater_mode', this.onCapabilityHotWaterMode.bind(this));
    this.registerCapabilityListener('power_boost', this.onCapabilityPowerBoost.bind(this));

    // Initial data fetch
    this.getDeviceData().catch(err => this.error('Startup fetch failed:', err));

    this.interval = setInterval(async () => {
      if (!this.isWriting) {
        await this.getDeviceData();
      }
    }, updateInterval);

    this.log('IVT heat pump device has been initialized');
  }

  // Build and connect an IVTClient from settings
  async getClient(settings) {
    const client = IVTClient({
      serialNumber: settings.serial,
      accessKey: settings.key,
      password: settings.password,
    });
    await client.connect();
    this.log('Device connected successfully to backend');

    // The IVT gateway processes PUT requests but never sends a response stanza back.
    // Override put() with fire-and-forget: queue the send (so it doesn't race with
    // in-flight GETs), send immediately, and resolve without waiting for a response.
    // The next poll will confirm the new value was applied.
    client.put = function(uri, data) {
      const encrypted = this.encrypt(typeof data === 'string' ? data : JSON.stringify(data));
      const body = [
        `PUT ${uri} HTTP/1.1`,
        `User-Agent: ${this.USERAGENT}`,
        `Content-Type: application/json`,
        `Content-Length: ${encrypted.length}`,
        ``,
        encrypted,
      ].join('\n\n');
      const message = this.buildMessage(body);
      return this.queue.add(() => {
        this.client.send(message);
        return Promise.resolve({ status: 'ok' });
      });
    };

    return client;
  }

  // --- CONTROL HANDLERS ---

  async onCapabilityTargetTemperature(value) {
    this.isWriting = true;
    const endpoint = '/heatingCircuits/hc1/temperatureRoomSetpoint';
    const payload = { value: parseFloat(value) };
    try {
      if (this.client) {
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
      if (this.client) {
        await this.client.put(endpoint, payload);
        return Promise.resolve();
      } else { throw new Error('Client not ready'); }
    } catch (err) {
      this.error('Failed to set Hot Water Mode:', err);
      return Promise.reject(err);
    } finally { this.isWriting = false; }
  }

  async onCapabilityPowerBoost(value) {
    this.isWriting = true;
    const endpoint = '/dhwCircuits/dhw1/charge';
    const payload = { value: value ? 'start' : 'stop' };
    try {
      if (this.client) {
        await this.client.put(endpoint, payload);
        return Promise.resolve();
      } else { throw new Error('Client not ready'); }
    } catch (err) {
      this.error('Failed to set Hot Water Boost:', err);
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
      } catch (err) {
        this.log(`Failed to fetch ${value.name}:`, err.message);
      }
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
        // temperatureRoomSetpoint works over XMPP (unlike Pointt cloud API)
        const res = await this.client.get('/heatingCircuits/hc1/temperatureRoomSetpoint');
        if (res && res.value != null) {
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

    if (!this.isWriting) {
      try {
        const res = await this.client.get('/dhwCircuits/dhw1/charge');
        if (res && res.value !== undefined) {
          this.updateValue('power_boost', res.value === 'start');
        }
      } catch (err) { this.log('Failed to fetch power_boost:', err.message); }
    }

    if (!this.isWriting) {
      await this.updateCumulativeEnergy();
    }

    if (!this.isWriting) {
      await this.updateCOP();
    }
  }

  async updateCumulativeEnergy() {
    const today = new Date().toISOString().split('T')[0];
    const lastDate = this.getStoreValue('energy_last_date');

    // Day rollover: add the previous day's complete total to the running base
    if (lastDate && lastDate !== today) {
      try {
        const res = await this.client.get(
          `/recordings/heatSources/total/energyMonitoring/consumedEnergy?interval=${lastDate}`
        );
        const dayTotal = (res.recording || []).reduce((sum, slot) => {
          return sum + (slot.c > 0 ? slot.y / slot.c : 0);
        }, 0);
        const newBase = (this.getStoreValue('energy_base_kwh') || 0) + dayTotal;
        await this.setStoreValue('energy_base_kwh', newBase);
        this.log(`Energy rollover: added ${dayTotal.toFixed(3)} kWh for ${lastDate}, base now ${newBase.toFixed(3)} kWh`);
      } catch (err) { this.log('Failed to roll over energy base:', err.message); }
    }
    await this.setStoreValue('energy_last_date', today);

    // Sum completed hours of today and add to base
    try {
      const res = await this.client.get(
        `/recordings/heatSources/total/energyMonitoring/consumedEnergy?interval=${today}`
      );
      const currentHour = new Date().getHours();
      const completedHours = Math.max(0, currentHour - 1);
      const todayPartial = (res.recording || [])
        .slice(0, completedHours)
        .reduce((sum, slot) => sum + (slot.c > 0 ? slot.y / slot.c : 0), 0);

      const base = this.getStoreValue('energy_base_kwh') || 0;
      this.updateValue('meter_power', Math.round((base + todayPartial) * 100) / 100);
    } catch (err) { this.log('Failed to update meter_power:', err.message); }
  }

  async updateCOP() {
    const today = new Date().toISOString().split('T')[0];
    const currentHour = new Date().getHours();
    const idx = Math.max(0, currentHour - 2);
    try {
      const [resConsumed, resOutput] = await Promise.all([
        this.client.get(`/recordings/heatSources/total/energyMonitoring/consumedEnergy?interval=${today}`),
        this.client.get(`/recordings/heatSources/total/energyMonitoring/outputProduced?interval=${today}`)
      ]);
      const consumed = resConsumed.recording?.[idx];
      const output = resOutput.recording?.[idx];
      if (!consumed || !output || consumed.c <= 0 || output.c <= 0) return;
      const consumedKwh = consumed.y / consumed.c;
      const outputKwh = output.y / output.c;
      if (consumedKwh <= 0) return;
      const cop = Math.round((outputKwh / consumedKwh) * 10) / 10;
      this.updateValue('cop', cop);
    } catch (err) { this.log('Failed to update COP:', err.message); }
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
    const credentialKeys = ['serial', 'key', 'password'];
    const credentialsChanged = changedKeys.some(k => credentialKeys.includes(k));

    if (credentialsChanged) {
      // Reconnect with new credentials
      if (this.client) {
        try { this.client.end(); } catch (_) {}
      }
      try {
        this.client = await this.getClient(newSettings);
        this.log('Client reconnected after credential change');
      } catch (e) {
        this.error('Failed to reconnect after settings change:', e.message);
        this.setUnavailable(e.message).catch(this.error);
      }
    }

    if (changedKeys.includes('interval')) {
      clearInterval(this.interval);
      this.interval = setInterval(async () => {
        if (!this.isWriting) {
          await this.getDeviceData();
        }
      }, newSettings.interval * 1000);
    }
  }

  async onDeleted() {
    clearInterval(this.interval);
    if (this.client) {
      try { this.client.end(); } catch (_) {}
    }
  }

}

module.exports = HeatPumpDevice;
