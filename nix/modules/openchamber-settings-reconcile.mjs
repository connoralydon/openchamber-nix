import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const HEALTH_ATTEMPTS = 240;
const HEALTH_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;
const SETTINGS_SURFACES = ['web', 'desktop', 'vscode', 'mobile'];

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

const isJsonObject = (value) => value instanceof Object && !Array.isArray(value);

const readJsonObject = async (filePath, readFileImpl = readFile) => {
  const value = JSON.parse(await readFileImpl(filePath, 'utf8'));
  if (!isJsonObject(value)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return value;
};

const validatePersistedSettings = async (filePath, readFileImpl = readFile) => {
  try {
    await readJsonObject(filePath, readFileImpl);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('Refusing to reconcile unreadable or malformed persisted settings', { cause: error });
  }
};

const requestJson = async (fetchImpl, url, options = {}) => {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${new URL(url).pathname} returned HTTP ${response.status}`);
  }

  const body = await response.json().catch(() => null);
  if (!isJsonObject(body)) {
    throw new Error(`${options.method ?? 'GET'} ${new URL(url).pathname} returned invalid JSON`);
  }
  return { body, response };
};

const readHealth = async (fetchImpl, baseUrl) => {
  try {
    const { body } = await requestJson(fetchImpl, `${baseUrl}/health`);
    return body;
  } catch {
    return null;
  }
};

const isReady = (health) =>
  health?.status === 'ok' && health.openCodeRunning === true && health.isOpenCodeReady === true;

const waitUntilReady = async (fetchImpl, baseUrl, sleepImpl) => {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    if (isReady(await readHealth(fetchImpl, baseUrl))) return;
    await sleepImpl(HEALTH_INTERVAL_MS);
  }
  throw new Error('OpenChamber and OpenCode did not become ready');
};

const waitForRestart = async (fetchImpl, baseUrl, sleepImpl) => {
  let stopped = false;
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    const health = await readHealth(fetchImpl, baseUrl);
    if (health === null) {
      stopped = true;
    } else if (stopped && isReady(health)) {
      return;
    }
    await sleepImpl(HEALTH_INTERVAL_MS);
  }
  throw new Error('OpenChamber did not complete its restart');
};

const sessionCookie = async (fetchImpl, baseUrl, password) => {
  if (password === null) return null;

  const { response } = await requestJson(fetchImpl, `${baseUrl}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')];
  const { port } = new URL(baseUrl);
  const cookie = setCookies
    .filter(Boolean)
    .map((value) => value.split(';', 1)[0])
    .find((value) => value.startsWith('oc_ui_session=') || (port && value.startsWith(`oc_ui_session_${port}=`)));
  if (!cookie) {
    throw new Error('OpenChamber authentication did not return a session cookie');
  }
  return cookie;
};

const settingsRequest = async (fetchImpl, baseUrl, cookie, { surface = null, ...options } = {}) => {
  const headers = { ...options.headers };
  if (cookie) headers.Cookie = cookie;
  const query = surface ? `?surface=${encodeURIComponent(surface)}` : '';
  return requestJson(fetchImpl, `${baseUrl}/api/config/settings${query}`, {
    ...options,
    headers,
  });
};

const mismatchedKeys = (desired, actual) =>
  Object.keys(desired).filter(
    (key) => !Object.hasOwn(actual, key) || !isDeepStrictEqual(actual[key], desired[key]),
  );

const valuesForKeys = (source, keys) =>
  Object.fromEntries(keys.map((key) => [key, source[key]]));

const reconcileSttApiKey = async (fetchImpl, baseUrl, cookie, sttApiKey, log) => {
  if (sttApiKey === null) return;

  const url = `${baseUrl}/api/voice/keys`;
  const headers = cookie ? { Cookie: cookie } : {};
  // The API reports only presence, so write on every run to apply key rotation.
  const { body: updated } = await requestJson(fetchImpl, url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stt: sttApiKey }),
  });
  if (updated.stt !== true) {
    throw new Error('OpenChamber rejected the managed transcription key');
  }
  const { body: verified } = await requestJson(fetchImpl, url, { headers });
  if (verified.stt !== true) {
    throw new Error('OpenChamber did not retain the managed transcription key');
  }
  log('[settings-reconcile] Updated transcription key');
};

export const reconcileSettings = async ({
  baseUrl,
  desiredSettings,
  desiredSettingsBySurface = {},
  password = null,
  sttApiKey = null,
  settingsFilePath,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  sleepImpl = sleep,
  log = console.log,
}) => {
  if (!isJsonObject(desiredSettings) || !isJsonObject(desiredSettingsBySurface)) {
    throw new Error('Managed settings and settingsBySurface must be JSON objects');
  }
  const targets = [{ surface: null, desired: desiredSettings }];
  for (const [surface, desired] of Object.entries(desiredSettingsBySurface)) {
    if (!SETTINGS_SURFACES.includes(surface) || !isJsonObject(desired)) {
      throw new Error(`Invalid managed settings profile: ${surface}`);
    }
    if (Object.keys(desired).length > 0) targets.push({ surface, desired });
  }
  const keyNames = (surface, keys) => keys.map((key) => surface ? `${surface}.${key}` : key);
  const transcriptionKey = sttApiKey === null ? null : sttApiKey.trim();
  if (transcriptionKey !== null && (
    !transcriptionKey || transcriptionKey.length > 1024 || /[\r\n]/.test(transcriptionKey)
  )) {
    throw new Error('The managed transcription key must be a nonempty single line of at most 1024 characters');
  }
  await waitUntilReady(fetchImpl, baseUrl, sleepImpl);
  await validatePersistedSettings(settingsFilePath, readFileImpl);

  let cookie = await sessionCookie(fetchImpl, baseUrl, password);
  const changedKeys = [];
  const staleKeys = [];
  for (const { surface, desired } of targets) {
    const { body: current } = await settingsRequest(fetchImpl, baseUrl, cookie, { surface });
    const changed = mismatchedKeys(desired, current);
    if (changed.length === 0) continue;
    const { body: updated } = await settingsRequest(fetchImpl, baseUrl, cookie, {
      surface,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valuesForKeys(desired, changed)),
    });
    const rejected = keyNames(surface, mismatchedKeys(desired, updated));
    if (rejected.length > 0) {
      throw new Error(`OpenChamber rejected or normalized managed settings: ${rejected.join(', ')}`);
    }
    changedKeys.push(...keyNames(surface, changed));
    const { body: verified } = await settingsRequest(fetchImpl, baseUrl, cookie, { surface });
    staleKeys.push(...keyNames(surface, mismatchedKeys(desired, verified)));
  }

  const restarted = staleKeys.length > 0;
  if (restarted) {
    log(`[settings-reconcile] Restarting OpenChamber after stale settings: ${staleKeys.join(', ')}`);
    const { body: shutdown } = await requestJson(fetchImpl, `${baseUrl}/api/system/shutdown`, {
      method: 'POST',
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (shutdown.ok !== true) {
      throw new Error('OpenChamber refused the restart request');
    }

    await waitForRestart(fetchImpl, baseUrl, sleepImpl);
    cookie = await sessionCookie(fetchImpl, baseUrl, password);
    for (const { surface, desired } of targets) {
      const { body: verified } = await settingsRequest(fetchImpl, baseUrl, cookie, { surface });
      const remaining = keyNames(surface, mismatchedKeys(desired, verified));
      if (remaining.length > 0) {
        throw new Error(`Managed settings still differ after restart: ${remaining.join(', ')}`);
      }
    }
  }

  await reconcileSttApiKey(fetchImpl, baseUrl, cookie, transcriptionKey, log);
  log(changedKeys.length === 0
    ? '[settings-reconcile] Managed settings already match'
    : `[settings-reconcile] Updated settings${restarted ? ' after restart' : ''}: ${changedKeys.join(', ')}`);
  return { changedKeys, restarted };
};

export const readCredential = async (name, {
  directory = process.env.CREDENTIALS_DIRECTORY,
  required = false,
  readFileImpl = readFile,
} = {}) => {
  if (directory) {
    try {
      const value = await readFileImpl(`${directory}/${name}`, 'utf8');
      return name === 'ui-password' ? value.split(/\r?\n/, 1)[0] : value;
    } catch (error) {
      if (required || error?.code !== 'ENOENT') {
        throw new Error(`Cannot read OpenChamber credential: ${name}`);
      }
    }
  }
  if (required) throw new Error(`Missing OpenChamber credential: ${name}`);
  return null;
};

const main = async () => {
  const baseUrl = process.env.OPENCHAMBER_RECONCILE_BASE_URL;
  const desiredSettingsFile = process.env.OPENCHAMBER_RECONCILE_DESIRED_SETTINGS_FILE;
  const desiredSurfaceSettingsFile = process.env.OPENCHAMBER_RECONCILE_DESIRED_SURFACE_SETTINGS_FILE;
  const settingsFilePath = process.env.OPENCHAMBER_RECONCILE_SETTINGS_FILE;
  if (!baseUrl || !desiredSettingsFile || !desiredSurfaceSettingsFile || !settingsFilePath) {
    throw new Error('OpenChamber settings reconciliation environment is incomplete');
  }

  await reconcileSettings({
    baseUrl,
    desiredSettings: await readJsonObject(desiredSettingsFile),
    desiredSettingsBySurface: await readJsonObject(desiredSurfaceSettingsFile),
    password: await readCredential('ui-password'),
    sttApiKey: process.env.OPENCHAMBER_RECONCILE_STT_API_KEY === 'true'
      ? await readCredential('stt-api-key', { required: true }) : null,
    settingsFilePath,
  });
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`[settings-reconcile] ${error.message}`);
    process.exitCode = 1;
  });
}
