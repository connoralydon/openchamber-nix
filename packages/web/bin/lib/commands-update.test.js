import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { createUpdateCommand } from './commands-update.js';

async function withTempOpenChamberDataDir(fn) {
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.OPENCHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.OPENCHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('update command', () => {
  it('uses the package-manager helpers on the update-available path', async () => {
    await withTempOpenChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const executeUpdate = vi.fn(() => ({ success: true, exitCode: 0 }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

      try {
        await updateCommand({ json: true });

        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true, targetVersion: '9.9.9' });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  describe('with the startup service running', () => {
    const serviceInstance = { pid: 4242, port: 3000, pidFilePath: '/fake/pid', instanceFilePath: '/fake/instance' };

    async function runUpdate({ serviceVersionReached }) {
      const calls = [];
      const serveCommand = vi.fn();
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand,
        discoverInstances: vi.fn(async () => [serviceInstance]),
        startupService: { getPid: () => 4242, restart: () => calls.push('restart') },
        waitForVersion: vi.fn(async (_instance, version) => {
          calls.push(`wait ${version}`);
          return serviceVersionReached;
        }),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'pnpm'),
          executeUpdate: vi.fn(() => {
            calls.push('install');
            return { success: true, exitCode: 0 };
          }),
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });
      return withTempOpenChamberDataDir(async () => {
        const originalWrite = process.stdout.write;
        process.stdout.write = vi.fn(() => true);
        try {
          const error = await updateCommand({ json: true }).then(() => null, (failure) => failure);
          return { calls, serveCommand, error };
        } finally {
          process.stdout.write = originalWrite;
        }
      });
    }

    it('lets systemd restart it once the install is done', async () => {
      const { calls, serveCommand, error } = await runUpdate({ serviceVersionReached: true });

      expect(error).toBeNull();
      expect(calls).toEqual(['install', 'restart', 'wait 9.9.9']);
      expect(serveCommand).not.toHaveBeenCalled();
    });

    it('fails when the service does not come back on the new version', async () => {
      const { error } = await runUpdate({ serviceVersionReached: false });

      expect(error?.message).toMatch(/not running 9\.9\.9.*openchamber startup enable/);
    });
  });

  it('surfaces the installed-version verification failure', async () => {
    await withTempOpenChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const executeUpdate = vi.fn(() => ({
        success: false,
        exitCode: 0,
        error: 'Installed @openchamber/web version 1.0.0 does not match target 9.9.9.',
      }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

      try {
        await expect(updateCommand({ json: true })).rejects.toThrow(/does not match target 9\.9\.9/);
        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true, targetVersion: '9.9.9' });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });
});
