import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildPreferencesFields,
  flattenPreferences,
  parsePreferencesDocument,
  serializePreferencesDocument,
} from './settings-files.js';

test('disjoint surface writes and base updates preserve other surface-only preferences', () => {
  const mobile = buildPreferencesFields({}, { fontSize: 17 }, 1, { surface: 'mobile', changedKeys: ['fontSize'] });
  const desktop = buildPreferencesFields(mobile, { sidebarGrouping: 'project' }, 2, {
    surface: 'desktop', changedKeys: ['sidebarGrouping'],
  });
  const web = buildPreferencesFields(desktop, { sidebarDetailedZoneRows: true }, 3, {
    surface: 'web', changedKeys: ['sidebarDetailedZoneRows'],
  });
  const common = buildPreferencesFields(web, { openTrackerLinksOnBoard: false }, 4, { changedKeys: ['openTrackerLinksOnBoard'] });
  const parsed = parsePreferencesDocument(serializePreferencesDocument(common));
  assert.equal(parsed.ok, true);
  assert.deepEqual(flattenPreferences(parsed.fields, 'mobile'), { fontSize: 17, openTrackerLinksOnBoard: false });
  assert.deepEqual(flattenPreferences(parsed.fields, 'desktop'), { sidebarGrouping: 'project', openTrackerLinksOnBoard: false });
  assert.deepEqual(flattenPreferences(parsed.fields, 'web'), { sidebarDetailedZoneRows: true, openTrackerLinksOnBoard: false });
  assert.deepEqual(flattenPreferences(parsed.fields), { openTrackerLinksOnBoard: false });
  assert.deepEqual(common.fontSize, mobile.fontSize);
  assert.deepEqual(common.sidebarGrouping, desktop.sidebarGrouping);
});

test('a resolved document can still remove a preference that was visible to it', () => {
  const before = {
    fontSize: { updatedAt: 1, surfaces: { mobile: { value: 17, updatedAt: 1 } } },
    sidebarGrouping: { updatedAt: 1, surfaces: { desktop: { value: 'project', updatedAt: 1 } } },
  };
  const after = buildPreferencesFields(before, {}, 2, { surface: 'mobile', changedKeys: ['fontSize'] });
  assert.equal(after.fontSize, undefined);
  assert.deepEqual(after.sidebarGrouping, before.sidebarGrouping);
});
