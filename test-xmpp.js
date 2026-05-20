'use strict';

/**
 * Standalone XMPP test script — run with:
 *   node test-xmpp.js
 *
 * Logs ALL incoming stanzas during a PUT to identify why responses are missed.
 */

const { IVTClient } = require('./lib/bosch-xmpp');

// ── Credentials ──────────────────────────────────────────────────────────────
const SERIAL   = process.env.SERIAL   || '176431053';
const KEY      = process.env.KEY      || 'PzXSw556pA645SKf';
const PASSWORD = process.env.PASSWORD || 'Es7eBX88hUUKWph';
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const client = IVTClient({
    serialNumber: SERIAL,
    accessKey: KEY,
    password: PASSWORD,
    retryTimeout: 8000,
    maxRetries: 1,
  });

  // ── Log ALL incoming stanzas so we can see what comes back ──────────────
  client.on('stanza', stanza => {
    console.log('\n[STANZA IN]', stanza.name,
      '| from:', stanza.attrs.from || '(none)',
      '| to:', stanza.attrs.to || '(none)',
      '| type:', stanza.attrs.type || '(none)');
    const body = stanza.getChild && stanza.getChild('body');
    if (body) {
      const text = body.getText ? body.getText() : '';
      console.log('  body preview:', text.slice(0, 80));
    }
  });

  await client.connect();
  console.log('\n✓ Connected. My JID:', client.jid, '\n');

  // ── Read current setpoint ────────────────────────────────────────────────
  let currentTemp;
  try {
    const res = await client.get('/heatingCircuits/hc1/temperatureRoomSetpoint');
    currentTemp = res.value;
    console.log('Current temperatureRoomSetpoint:', currentTemp);
  } catch (err) {
    console.log('Read failed:', err.message);
    client.end();
    process.exit(1);
  }

  console.log('\n── Sending PUT now ─────────────────────────────────────────');
  console.log('(watch for [STANZA IN] lines — any response at all?)\n');

  // ── Send PUT with default format ─────────────────────────────────────────
  try {
    const result = await client.put('/heatingCircuits/hc1/temperatureRoomSetpoint', { value: currentTemp });
    console.log('\n✓ PUT succeeded:', JSON.stringify(result));
  } catch (err) {
    console.log('\n✗ PUT failed:', err.message);
  }

  console.log('\n✓ Done');
  client.end();
  process.exit(0);
})();
