import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileSettings } from './openchamber-settings-reconcile.mjs';

const readyHealth = {
  status: 'ok',
  openCodeRunning: true,
  isOpenCodeReady: true,
};

const jsonResponse = (body, { headers, status = 200 } = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...headers },
    status,
  });

const persistedSettings = async () => '{"existing":true}';
const noSleep = async () => {};

test('does not write settings that already match', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ method: options.method ?? 'GET', path: new URL(url).pathname });
    if (url.endsWith('/health')) return jsonResponse(readyHealth);
    return jsonResponse({ themeVariant: 'dark', untouched: true });
  };

  const result = await reconcileSettings({
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: { themeVariant: 'dark' },
    settingsFilePath: '/state/settings.json',
    fetchImpl,
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  });

  assert.deepEqual(result, { changedKeys: [], restarted: false });
  assert.deepEqual(requests, [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/api/config/settings' },
  ]);
});

test('authenticates and sends only changed configured keys', async () => {
  const requests = [];
  let settingsReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push({
      body: options.body,
      cookie: options.headers?.Cookie,
      method: options.method ?? 'GET',
      path,
    });
    if (path === '/health') return jsonResponse(readyHealth);
    if (path === '/auth/session') {
      return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': 'oc_ui_session=session; Path=/; HttpOnly' } });
    }
    if (options.method === 'PUT') {
      return jsonResponse({ themeVariant: 'dark', notificationMode: 'always', untouched: true });
    }
    settingsReads += 1;
    if (settingsReads === 1) {
      return jsonResponse({ themeVariant: 'light', notificationMode: 'always', untouched: true });
    }
    return jsonResponse({ themeVariant: 'dark', notificationMode: 'always', untouched: true });
  };

  const result = await reconcileSettings({
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: { themeVariant: 'dark', notificationMode: 'always' },
    password: 'secret',
    settingsFilePath: '/state/settings.json',
    fetchImpl,
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  });

  assert.deepEqual(result, { changedKeys: ['themeVariant'], restarted: false });
  const login = requests.find((request) => request.path === '/auth/session');
  assert.deepEqual(JSON.parse(login.body), { password: 'secret' });
  const update = requests.find((request) => request.method === 'PUT');
  assert.deepEqual(JSON.parse(update.body), { themeVariant: 'dark' });
  assert.equal(update.cookie, 'oc_ui_session=session');
});

test('does not restart when the server rejects a value', async () => {
  let shutdownRequests = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/health') return jsonResponse(readyHealth);
    if (path === '/api/system/shutdown') shutdownRequests += 1;
    if (options.method === 'PUT') return jsonResponse({ themeVariant: 'light' });
    return jsonResponse({ themeVariant: 'light' });
  };

  await assert.rejects(
    reconcileSettings({
      baseUrl: 'http://127.0.0.1:3000',
      desiredSettings: { themeVariant: 'invalid' },
      settingsFilePath: '/state/settings.json',
      fetchImpl,
      readFileImpl: persistedSettings,
      sleepImpl: noSleep,
      log: () => {},
    }),
    /rejected or normalized managed settings: themeVariant/,
  );
  assert.equal(shutdownRequests, 0);
});

test('restarts once when a successful update is not visible to a new read', async () => {
  let authenticatedSessions = 0;
  let settingsReads = 0;
  let shutdownRequests = 0;
  let restartHealthReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/health') {
      if (shutdownRequests === 0) return jsonResponse(readyHealth);
      restartHealthReads += 1;
      if (restartHealthReads === 1) throw new Error('connection refused');
      return jsonResponse(readyHealth);
    }
    if (path === '/auth/session') {
      authenticatedSessions += 1;
      return jsonResponse(
        { ok: true },
        { headers: { 'Set-Cookie': `oc_ui_session=session-${authenticatedSessions}; Path=/` } },
      );
    }
    if (path === '/api/system/shutdown') {
      shutdownRequests += 1;
      return jsonResponse({ ok: true });
    }
    if (options.method === 'PUT') return jsonResponse({ themeVariant: 'dark' });
    settingsReads += 1;
    if (settingsReads < 3) return jsonResponse({ themeVariant: 'light' });
    return jsonResponse({ themeVariant: 'dark' });
  };

  const result = await reconcileSettings({
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: { themeVariant: 'dark' },
    password: 'secret',
    settingsFilePath: '/state/settings.json',
    fetchImpl,
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  });

  assert.deepEqual(result, { changedKeys: ['themeVariant'], restarted: true });
  assert.equal(authenticatedSessions, 2);
  assert.equal(shutdownRequests, 1);
});

test('refuses to update when persisted settings are malformed', async () => {
  let requests = 0;
  await assert.rejects(
    reconcileSettings({
      baseUrl: 'http://127.0.0.1:3000',
      desiredSettings: { themeVariant: 'dark' },
      settingsFilePath: '/state/settings.json',
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse(readyHealth);
      },
      readFileImpl: async () => '{',
      sleepImpl: noSleep,
      log: () => {},
    }),
    /Refusing to reconcile unreadable or malformed persisted settings/,
  );
  assert.equal(requests, 1);
});
