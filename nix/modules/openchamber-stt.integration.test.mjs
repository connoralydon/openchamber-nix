import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const webRoot = process.env.OPENCHAMBER_TEST_WEB_ROOT;
if (!webRoot) throw new Error('OPENCHAMBER_TEST_WEB_ROOT is required');

test('runtime credentials reach the saved key and the real transcription route', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-stt-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  process.env.OPENCHAMBER_DATA_DIR = directory;
  process.env.OPENAI_API_KEY = 'test-only-unrelated-environment-key';

  const require = createRequire(path.join(webRoot, 'package.json'));
  const express = require('express');
  const { registerTtsRoutes } = await import(pathToFileURL(path.join(webRoot, 'server/lib/tts/routes.js')));
  const { readVoiceKey, updateVoiceKeys } = await import(pathToFileURL(path.join(webRoot, 'server/lib/tts/voice-keys.js')));
  updateVoiceKeys({ openai: 'test-only-read-aloud', stt: 'test-only-old' });

  let receivedAuthorization;
  const provider = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/audio/transcriptions');
    receivedAuthorization = req.headers.authorization;
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'test transcription' }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;

  let settings = {};
  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok', openCodeRunning: true, isOpenCodeReady: true }));
  app.post('/auth/session', express.json(), (req, res) => {
    assert.equal(req.body.password, 'test-only-password');
    res.setHeader('Set-Cookie', 'oc_ui_session=test-only-session; Path=/; HttpOnly');
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    if (req.headers.cookie !== 'oc_ui_session=test-only-session') return res.sendStatus(401);
    next();
  });
  app.get('/api/config/settings', (_req, res) => res.json(settings));
  app.put('/api/config/settings', express.json(), (req, res) => {
    settings = { ...settings, ...req.body };
    res.json(settings);
  });
  registerTtsRoutes(app, { sayTTSCapability: () => false });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const desiredSettingsFile = path.join(directory, 'desired.json');
  await writeFile(desiredSettingsFile, JSON.stringify({
    sttProvider: 'openai-compatible', sttServerUrl: providerUrl, sttModel: 'test-only-model',
  }));
  const desiredSurfaceSettingsFile = path.join(directory, 'desired-surfaces.json');
  await writeFile(desiredSurfaceSettingsFile, '{}');
  await writeFile(path.join(directory, 'ui-password'), 'test-only-password\n', { mode: 0o600 });

  for (const key of ['test-only-first', 'test-only-rotated']) {
    await writeFile(path.join(directory, 'stt-api-key'), `${key}\n`, { mode: 0o600 });
    const { stdout, stderr } = await run(process.execPath, [
      fileURLToPath(new URL('./openchamber-settings-reconcile.mjs', import.meta.url)),
    ], {
      timeout: 10_000,
      env: {
        ...process.env,
        CREDENTIALS_DIRECTORY: directory,
        OPENCHAMBER_RECONCILE_BASE_URL: baseUrl,
        OPENCHAMBER_RECONCILE_DESIRED_SETTINGS_FILE: desiredSettingsFile,
        OPENCHAMBER_RECONCILE_DESIRED_SURFACE_SETTINGS_FILE: desiredSurfaceSettingsFile,
        OPENCHAMBER_RECONCILE_SETTINGS_FILE: path.join(directory, 'settings.json'),
        OPENCHAMBER_RECONCILE_STT_API_KEY: 'true',
      },
    });
    assert.ok(!stdout.includes(key) && !stderr.includes(key));
    assert.equal(readVoiceKey('stt'), key);
    assert.equal(readVoiceKey('openai'), 'test-only-read-aloud');
    assert.equal((await stat(path.join(directory, 'voice-keys.json'))).mode & 0o777, 0o600);

    const response = await fetch(`${baseUrl}/api/stt/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav', Cookie: 'oc_ui_session=test-only-session',
        'X-Base-URL': providerUrl, 'X-Model': 'test-only-model',
      },
      body: Buffer.from('test-only-audio'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { transcript: 'test transcription' });
    assert.equal(receivedAuthorization, `Bearer ${key}`);
  }
});
