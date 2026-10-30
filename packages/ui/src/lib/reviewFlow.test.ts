import { beforeEach, describe, expect, test } from 'bun:test';
import { switchRuntimeEndpoint } from './runtime-switch';

import { assertAutoReviewRuntimeStillCurrent, isAutoReviewRuntimeCurrent } from './reviewFlow';

describe('reviewFlow auto-review helpers', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
  });

  test('runtime guard rejects a start that began on another runtime', () => {
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(true);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(false);
    expect(() => assertAutoReviewRuntimeStillCurrent('runtime-a')).toThrow('runtime changed');
  });
});
