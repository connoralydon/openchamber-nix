import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const HEALTH_ATTEMPTS = 240;
const HEALTH_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;

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

const settingsRequest = async (fetchImpl, baseUrl, cookie, options = {}) => {
  const headers = { ...options.headers };
  if (cookie) headers.Cookie = cookie;
  return requestJson(fetchImpl, `${baseUrl}/api/config/settings`, {
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

export const reconcileSettings = async ({
  baseUrl,
  desiredSettings,
  password = null,
  settingsFilePath,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  sleepImpl = sleep,
  log = console.log,
}) => {
  await waitUntilReady(fetchImpl, baseUrl, sleepImpl);
  await validatePersistedSettings(settingsFilePath, readFileImpl);

  const cookie = await sessionCookie(fetchImpl, baseUrl, password);
  const { body: current } = await settingsRequest(fetchImpl, baseUrl, cookie);
  const changedKeys = mismatchedKeys(desiredSettings, current);
  if (changedKeys.length === 0) {
    log('[settings-reconcile] Managed settings already match');
    return { changedKeys, restarted: false };
  }

  const changes = valuesForKeys(desiredSettings, changedKeys);
  const { body: updated } = await settingsRequest(fetchImpl, baseUrl, cookie, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  const rejectedKeys = mismatchedKeys(desiredSettings, updated);
  if (rejectedKeys.length > 0) {
    throw new Error(`OpenChamber rejected or normalized managed settings: ${rejectedKeys.join(', ')}`);
  }

  const { body: verified } = await settingsRequest(fetchImpl, baseUrl, cookie);
  const staleKeys = mismatchedKeys(desiredSettings, verified);
  if (staleKeys.length === 0) {
    log(`[settings-reconcile] Updated settings: ${changedKeys.join(', ')}`);
    return { changedKeys, restarted: false };
  }

  log(`[settings-reconcile] Restarting OpenChamber after stale settings: ${staleKeys.join(', ')}`);
  const { body: shutdown } = await requestJson(fetchImpl, `${baseUrl}/api/system/shutdown`, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
  });
  if (shutdown.ok !== true) {
    throw new Error('OpenChamber refused the restart request');
  }

  await waitForRestart(fetchImpl, baseUrl, sleepImpl);
  const restartedCookie = await sessionCookie(fetchImpl, baseUrl, password);
  const { body: restartedSettings } = await settingsRequest(fetchImpl, baseUrl, restartedCookie);
  const remainingKeys = mismatchedKeys(desiredSettings, restartedSettings);
  if (remainingKeys.length > 0) {
    throw new Error(`Managed settings still differ after restart: ${remainingKeys.join(', ')}`);
  }

  log(`[settings-reconcile] Updated settings after restart: ${changedKeys.join(', ')}`);
  return { changedKeys, restarted: true };
};

const readCredential = async () => {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) return null;
  const value = await readFile(`${directory}/ui-password`, 'utf8');
  return value.split(/\r?\n/, 1)[0];
};

const main = async () => {
  const baseUrl = process.env.OPENCHAMBER_RECONCILE_BASE_URL;
  const desiredSettingsFile = process.env.OPENCHAMBER_RECONCILE_DESIRED_SETTINGS_FILE;
  const settingsFilePath = process.env.OPENCHAMBER_RECONCILE_SETTINGS_FILE;
  if (!baseUrl || !desiredSettingsFile || !settingsFilePath) {
    throw new Error('OpenChamber settings reconciliation environment is incomplete');
  }

  await reconcileSettings({
    baseUrl,
    desiredSettings: await readJsonObject(desiredSettingsFile),
    password: await readCredential(),
    settingsFilePath,
  });
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`[settings-reconcile] ${error.message}`);
    process.exitCode = 1;
  });
}
