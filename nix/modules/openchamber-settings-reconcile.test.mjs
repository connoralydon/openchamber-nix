import assert from 'node:assert/strict';
import test from 'node:test';

import { readCredential, reconcileSettings } from './openchamber-settings-reconcile.mjs';

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

for (const [baseUrl, cookie] of [
  ['http://127.0.0.1:3210', 'oc_ui_session_3210=session'],
  ['http://[::1]:3000', 'oc_ui_session_3000=session'],
  ['http://localhost', 'oc_ui_session=session'],
]) {
  test(`authenticates at ${baseUrl} with the matching session cookie`, async () => {
    const fetchImpl = async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === '/health') return jsonResponse(readyHealth);
      if (path === '/auth/session') {
        const response = jsonResponse({ ok: true }, { headers: { 'Set-Cookie': 'unrelated=value; Path=/' } });
        response.headers.append('Set-Cookie', `${cookie}; Path=/; HttpOnly`);
        return response;
      }
      assert.equal(path, '/api/config/settings');
      assert.equal(options.headers.Cookie, cookie);
      return jsonResponse({ themeVariant: 'dark' });
    };

    const result = await reconcileSettings({
      baseUrl,
      desiredSettings: { themeVariant: 'dark' },
      password: 'secret',
      settingsFilePath: '/state/settings.json',
      fetchImpl,
      readFileImpl: persistedSettings,
      sleepImpl: noSleep,
      log: () => {},
    });

    assert.deepEqual(result, { changedKeys: [], restarted: false });
  });
}

for (const cookie of [null, 'unrelated=session', 'oc_ui_session_3001=session', 'oc_ui_session_extra=session']) {
  test(`rejects authentication without a matching session cookie: ${cookie}`, async () => {
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path === '/health') return jsonResponse(readyHealth);
      assert.equal(path, '/auth/session');
      return jsonResponse({ ok: true }, { headers: cookie ? { 'Set-Cookie': `${cookie}; Path=/` } : {} });
    };

    await assert.rejects(
      reconcileSettings({
        baseUrl: 'http://127.0.0.1:3000',
        desiredSettings: { themeVariant: 'dark' },
        password: 'secret',
        settingsFilePath: '/state/settings.json',
        fetchImpl,
        readFileImpl: persistedSettings,
        sleepImpl: noSleep,
        log: () => {},
      }),
      /OpenChamber authentication did not return a session cookie/,
    );
  });
}

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
  let voiceKeyWrites = 0;
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
        { headers: { 'Set-Cookie': `oc_ui_session_3000=session-${authenticatedSessions}; Path=/` } },
      );
    }
    assert.equal(options.headers.Cookie, `oc_ui_session_3000=session-${authenticatedSessions}`);
    if (path === '/api/system/shutdown') {
      shutdownRequests += 1;
      return jsonResponse({ ok: true });
    }
    if (path === '/api/voice/keys') {
      assert.equal(authenticatedSessions, 2);
      if (options.method === 'PUT') {
        voiceKeyWrites += 1;
        assert.deepEqual(JSON.parse(options.body), { stt: 'test-only-key' });
      }
      return jsonResponse({ stt: true });
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
    sttApiKey: 'test-only-key',
    settingsFilePath: '/state/settings.json',
    fetchImpl,
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  });

  assert.deepEqual(result, { changedKeys: ['themeVariant'], restarted: true });
  assert.equal(authenticatedSessions, 2);
  assert.equal(shutdownRequests, 1);
  assert.equal(voiceKeyWrites, 1);
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

test('sets and rotates only the transcription key even when settings already match', async () => {
  const requests = [];
  const logs = [];
  const keys = { openai: 'test-only-read-aloud', stt: 'test-only-old' };
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    requests.push({ pathname, ...options });
    if (pathname === '/health') return jsonResponse(readyHealth);
    if (pathname === '/auth/session') {
      return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': 'oc_ui_session_3000=session; Path=/' } });
    }
    assert.equal(options.headers.Cookie, 'oc_ui_session_3000=session');
    if (pathname === '/api/config/settings') return jsonResponse({ sttProvider: 'openai-compatible' });
    assert.equal(pathname, '/api/voice/keys');
    if (options.method === 'PUT') Object.assign(keys, JSON.parse(options.body));
    return jsonResponse({ openai: true, stt: true });
  };

  for (const key of ['test-only-first', 'test-only-rotated']) {
    const result = await reconcileSettings({
      baseUrl: 'http://127.0.0.1:3000',
      desiredSettings: { sttProvider: 'openai-compatible' },
      password: 'test-only-password',
      sttApiKey: `${key}\n`,
      settingsFilePath: '/state/settings.json',
      fetchImpl,
      readFileImpl: persistedSettings,
      sleepImpl: noSleep,
      log: (message) => logs.push(message),
    });
    assert.deepEqual(result, { changedKeys: [], restarted: false });
    assert.deepEqual(keys, { openai: 'test-only-read-aloud', stt: key });
    assert.ok(logs.every((message) => !message.includes(key)));
  }
  const writes = requests.filter((request) => request.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.ok(writes.every((request) => request.pathname === '/api/voice/keys'));
});

test('verifies the configured transcription URL before setting the key', async () => {
  const order = [];
  let settings = { sttServerUrl: 'http://old.example/v1' };
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    order.push(`${options.method ?? 'GET'} ${pathname}`);
    if (pathname === '/health') return jsonResponse(readyHealth);
    if (pathname === '/api/config/settings') {
      if (options.method === 'PUT') settings = JSON.parse(options.body);
      return jsonResponse(settings);
    }
    return jsonResponse({ stt: true });
  };

  await reconcileSettings({
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: { sttServerUrl: 'https://api.openai.com/v1' },
    sttApiKey: 'test-only-key',
    settingsFilePath: '/state/settings.json',
    fetchImpl,
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  });
  assert.deepEqual(order, [
    'GET /health',
    'GET /api/config/settings',
    'PUT /api/config/settings',
    'GET /api/config/settings',
    'PUT /api/voice/keys',
    'GET /api/voice/keys',
  ]);
});

for (const key of ['', '   ', 'first\nsecond', 'x'.repeat(1025)]) {
  test('rejects an invalid transcription key before any request', async () => {
    let requests = 0;
    await assert.rejects(reconcileSettings({
      baseUrl: 'http://127.0.0.1:3000',
      desiredSettings: {},
      sttApiKey: key,
      settingsFilePath: '/state/settings.json',
      fetchImpl: async () => { requests += 1; },
    }), /managed transcription key must be a nonempty single line/);
    assert.equal(requests, 0);
  });
}

for (const failure of ['http', 'rejected', 'not-retained']) {
  test(`reports transcription key failure without exposing the key: ${failure}`, async () => {
    const logs = [];
    const fetchImpl = async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/health') return jsonResponse(readyHealth);
      if (pathname === '/api/config/settings') return jsonResponse({});
      if (failure === 'http') return jsonResponse({ error: 'test-only-sensitive-response' }, { status: 500 });
      return jsonResponse({ stt: failure === 'not-retained' && options.method === 'PUT' });
    };
    await assert.rejects(reconcileSettings({
      baseUrl: 'http://127.0.0.1:3000',
      desiredSettings: {},
      sttApiKey: 'test-only-sensitive-key',
      settingsFilePath: '/state/settings.json',
      fetchImpl,
      readFileImpl: persistedSettings,
      sleepImpl: noSleep,
      log: (message) => logs.push(message),
    }), (error) => {
      assert.match(error.message, /HTTP 500|rejected the managed transcription key|did not retain the managed transcription key/);
      assert.ok(!error.message.includes('test-only-sensitive'));
      return true;
    });
    assert.deepEqual(logs, []);
  });
}

test('does not install a key when settings are rejected', async () => {
  await assert.rejects(reconcileSettings({
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: { sttServerUrl: 'https://api.openai.com/v1' },
    sttApiKey: 'test-only-key',
    settingsFilePath: '/state/settings.json',
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/health') return jsonResponse(readyHealth);
      assert.equal(pathname, '/api/config/settings');
      return jsonResponse({});
    },
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  }), /rejected or normalized managed settings/);
});

test('a key-only credential directory does not require a UI password', async () => {
  assert.equal(await readCredential('ui-password', {
    directory: '/credentials',
    readFileImpl: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), null);
  assert.equal(await readCredential('stt-api-key', {
    directory: '/credentials',
    required: true,
    readFileImpl: async (file) => {
      assert.equal(file, '/credentials/stt-api-key');
      return 'test-only-key\n';
    },
  }), 'test-only-key\n');
});

test('missing or unreadable credentials fail without exposing underlying errors', async () => {
  await assert.rejects(readCredential('stt-api-key', { directory: '', required: true }), /Missing OpenChamber credential/);
  for (const code of ['ENOENT', 'EACCES']) {
    await assert.rejects(readCredential('stt-api-key', {
      directory: '/credentials',
      required: true,
      readFileImpl: async () => { throw Object.assign(new Error('test-only-sensitive-error'), { code }); },
    }), /Cannot read OpenChamber credential: stt-api-key/);
  }
});

test('reconciles saved surface overrides without changing unmanaged values, then does no writes', async () => {
  const common = { openTrackerLinksOnBoard: true, sidebarGrouping: 'time', untouched: 'common' };
  const profiles = {
    web: { sidebarGrouping: 'time', untouched: 'web' },
    mobile: { sidebarGrouping: 'time', sidebarDetailedZoneRows: false, untouched: 'mobile' },
    desktop: { sidebarGrouping: 'time', untouched: 'desktop' },
  };
  const writes = [];
  const fetchImpl = async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/health') return jsonResponse(readyHealth);
    assert.equal(pathname, '/api/config/settings');
    const surface = searchParams.get('surface');
    const target = surface ? profiles[surface] : common;
    if (options.method === 'PUT') {
      const changes = JSON.parse(options.body);
      writes.push({ surface, changes });
      Object.assign(target, changes);
    }
    return jsonResponse(surface ? { ...common, ...target } : common);
  };
  const options = {
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: { openTrackerLinksOnBoard: false },
    desiredSettingsBySurface: {
      web: { sidebarGrouping: 'project' },
      mobile: { sidebarGrouping: 'project', sidebarDetailedZoneRows: true },
    },
    settingsFilePath: '/state/settings.json',
    fetchImpl,
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  };

  assert.deepEqual(await reconcileSettings(options), {
    changedKeys: ['openTrackerLinksOnBoard', 'web.sidebarGrouping', 'mobile.sidebarGrouping', 'mobile.sidebarDetailedZoneRows'],
    restarted: false,
  });
  assert.deepEqual(writes, [
    { surface: null, changes: { openTrackerLinksOnBoard: false } },
    { surface: 'web', changes: { sidebarGrouping: 'project' } },
    { surface: 'mobile', changes: { sidebarGrouping: 'project', sidebarDetailedZoneRows: true } },
  ]);
  assert.equal(common.sidebarGrouping, 'time');
  assert.equal(common.untouched, 'common');
  assert.equal(profiles.web.untouched, 'web');
  assert.equal(profiles.mobile.untouched, 'mobile');
  assert.deepEqual(profiles.desktop, { sidebarGrouping: 'time', untouched: 'desktop' });

  assert.deepEqual(await reconcileSettings(options), { changedKeys: [], restarted: false });
  assert.equal(writes.length, 3);
});

test('restarts at most once for stale settings in multiple surface profiles', async () => {
  let shutdowns = 0;
  let restartHealthReads = 0;
  const written = new Map();
  const fetchImpl = async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/health') {
      if (shutdowns > 0 && restartHealthReads++ === 0) throw new Error('connection refused');
      return jsonResponse(readyHealth);
    }
    if (pathname === '/api/system/shutdown') {
      shutdowns += 1;
      return jsonResponse({ ok: true });
    }
    assert.equal(pathname, '/api/config/settings');
    const surface = searchParams.get('surface');
    if (!surface) return jsonResponse({});
    if (options.method === 'PUT') {
      const changes = JSON.parse(options.body);
      written.set(surface, changes);
      return jsonResponse(changes);
    }
    return jsonResponse(shutdowns ? written.get(surface) : { sidebarDetailedZoneRows: false });
  };

  const result = await reconcileSettings({
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: {},
    desiredSettingsBySurface: {
      web: { sidebarDetailedZoneRows: true },
      mobile: { sidebarDetailedZoneRows: true },
    },
    settingsFilePath: '/state/settings.json',
    fetchImpl,
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  });
  assert.deepEqual(result, {
    changedKeys: ['web.sidebarDetailedZoneRows', 'mobile.sidebarDetailedZoneRows'],
    restarted: true,
  });
  assert.equal(shutdowns, 1);
  assert.equal(written.size, 2);
});

test('reports a rejected surface setting without restarting or writing the voice key', async () => {
  await assert.rejects(reconcileSettings({
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: {},
    desiredSettingsBySurface: { mobile: { sidebarDetailedZoneRows: true } },
    sttApiKey: 'test-only-key',
    settingsFilePath: '/state/settings.json',
    fetchImpl: async (url) => {
      const { pathname } = new URL(url);
      if (pathname === '/health') return jsonResponse(readyHealth);
      assert.equal(pathname, '/api/config/settings');
      return jsonResponse({ sidebarDetailedZoneRows: false });
    },
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  }), /rejected or normalized managed settings: mobile.sidebarDetailedZoneRows/);
});

test('does not write when a surface settings read fails', async () => {
  await assert.rejects(reconcileSettings({
    baseUrl: 'http://127.0.0.1:3000',
    desiredSettings: {},
    desiredSettingsBySurface: { mobile: { sidebarDetailedZoneRows: true } },
    settingsFilePath: '/state/settings.json',
    fetchImpl: async (url, options = {}) => {
      assert.notEqual(options.method, 'PUT');
      const { pathname, searchParams } = new URL(url);
      if (pathname === '/health') return jsonResponse(readyHealth);
      assert.equal(pathname, '/api/config/settings');
      return searchParams.has('surface') ? jsonResponse({}, { status: 500 }) : jsonResponse({});
    },
    readFileImpl: persistedSettings,
    sleepImpl: noSleep,
    log: () => {},
  }), /returned HTTP 500/);
});

for (const desiredSettingsBySurface of [{ phone: {} }, { mobile: [] }, null]) {
  test('rejects invalid surface configuration before any request', async () => {
    await assert.rejects(reconcileSettings({
      baseUrl: 'http://127.0.0.1:3000',
      desiredSettings: {},
      desiredSettingsBySurface,
      fetchImpl: async () => assert.fail('must not request settings'),
    }), /Invalid managed settings profile|must be JSON objects/);
  });
}
