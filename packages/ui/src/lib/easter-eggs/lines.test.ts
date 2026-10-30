import { describe, expect, test } from 'bun:test';

import { LOCALES, type Locale } from '@/lib/i18n/runtime';

import { isDeepNight, isFridayEvening, isSmallHours, occasionOf } from './calendar';
import { copy as ar } from './copy/ar';
import { copy as de } from './copy/de';
import { copy as en } from './copy/en';
import { copy as es } from './copy/es';
import { copy as fr } from './copy/fr';
import { copy as he } from './copy/he';
import { copy as ja } from './copy/ja';
import { copy as ko } from './copy/ko';
import { copy as nl } from './copy/nl';
import { copy as pl } from './copy/pl';
import { copy as ptBR } from './copy/pt-BR';
import { copy as tr } from './copy/tr';
import type { EasterEggCopy } from './copy/types';
import { copy as uk } from './copy/uk';
import { copy as zhCN } from './copy/zh-CN';
import { copy as zhTW } from './copy/zh-TW';
import { draftMomentAt, draftTitleLine, gitCleanLine, netDeletionLine, NET_DELETION_THRESHOLD, pushLine } from './lines';

const COPIES = {
  en, de, fr, nl, 'zh-CN': zhCN, 'zh-TW': zhTW, uk, es, 'pt-BR': ptBR, ko, pl, ja, tr, ar, he,
} satisfies Record<Locale, EasterEggCopy>;

// Local time, the way the app reads the clock. 2026-10-30 is a Friday.
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute);

describe('calendar', () => {
  test('names the occasions by local date', () => {
    expect(occasionOf(at(10, 31, 0))).toBe('halloween');
    expect(occasionOf(at(10, 31, 23, 59))).toBe('halloween');
    expect(occasionOf(at(11, 1, 0))).toBeNull();
    expect(occasionOf(at(12, 31, 12))).toBe('newYearsEve');
    expect(occasionOf(at(1, 1, 12))).toBe('newYearsDay');
    expect(occasionOf(at(6, 15, 12))).toBeNull();
  });

  test('Friday evening runs from 18:00 to midnight', () => {
    expect(isFridayEvening(at(10, 30, 17, 59))).toBe(false);
    expect(isFridayEvening(at(10, 30, 18))).toBe(true);
    expect(isFridayEvening(at(10, 30, 23, 59))).toBe(true);
    expect(isFridayEvening(at(10, 31, 0, 30))).toBe(false);
    expect(isFridayEvening(at(10, 29, 20))).toBe(false);
  });

  test('small hours start at midnight, deep night at 01:00, both end at 05:00', () => {
    expect(isSmallHours(at(10, 28, 0, 10))).toBe(true);
    expect(isSmallHours(at(10, 28, 4, 59))).toBe(true);
    expect(isSmallHours(at(10, 28, 5))).toBe(false);
    expect(isDeepNight(at(10, 28, 0, 59))).toBe(false);
    expect(isDeepNight(at(10, 28, 1))).toBe(true);
    expect(isDeepNight(at(10, 28, 5))).toBe(false);
  });
});

describe('lines', () => {
  test('an occasion outranks the night for the draft heading', () => {
    expect(draftMomentAt(at(10, 31, 2))).toBe('halloween');
    expect(draftMomentAt(at(10, 28, 2))).toBe('deepNight');
    expect(draftMomentAt(at(10, 28, 14))).toBe('everyday');
    expect(draftTitleLine(en, 'deepNight', 6)).toBe('Still up? What are we working on in {project}?');
  });

  test('an empty occasion list falls back to everyday lines', () => {
    const plain: EasterEggCopy = { ...en, gitClean: { ...en.gitClean, halloween: [] } };
    expect(en.gitClean.everyday).toContain(gitCleanLine(plain, at(10, 31, 12), 0) ?? '');
  });

  test('a late push names its time, a Friday evening push gets the brave line', () => {
    expect(pushLine(en, at(10, 28, 2, 14), 'en-US', 0)?.title).toBe('Pushed at 2:14 AM.');
    expect(pushLine(en, at(10, 28, 2, 14), 'en-US', 4)?.title).toBe('2:14 AM, pushed.');
    expect(pushLine(en, at(10, 30, 19), 'en-US', 0)?.title).toBe('Brave.');
    expect(pushLine(en, at(10, 30, 19), 'en-US', 1)?.title).toBe('Bold move.');
    expect(pushLine(en, at(10, 28, 14), 'en-US', 0)).toBeNull();
    // Friday evening is the weekend there already: an ordinary toast.
    expect(pushLine(he, at(10, 30, 19), 'he-IL', 0)).toBeNull();
  });

  test('only a clear net deletion gets a line, in the right plural', () => {
    expect(netDeletionLine(en, { insertions: 5, deletions: 5 + NET_DELETION_THRESHOLD - 1 }, 'en-US', 0)).toBeNull();
    expect(netDeletionLine(en, { insertions: 3, deletions: 415 }, 'en-US', 0)?.title).toBe('412 lines retired.');
    expect(netDeletionLine(uk, { insertions: 0, deletions: 22 }, 'uk-UA', 1)?.title).toBe('−22 рядки.');
    expect(netDeletionLine(uk, { insertions: 0, deletions: 25 }, 'uk-UA', 1)?.title).toBe('−25 рядків.');
    expect(netDeletionLine(en, { insertions: 0, deletions: 1200 }, 'en-US', 1)?.title).toBe('−1,200 lines.');
  });
});

describe('every locale', () => {
  test('has its own copy', () => {
    expect(Object.keys(COPIES).sort()).toEqual([...LOCALES].sort());
  });

  for (const [locale, copy] of Object.entries(COPIES)) {
    test(`${locale}: placeholders are where the code fills them`, () => {
      expect(copy.draftTitle.everyday.length).toBeGreaterThan(0);
      expect(copy.gitClean.everyday.length).toBeGreaterThan(0);
      expect(copy.netDeletionCommit.length).toBeGreaterThan(0);
      for (const line of Object.values(copy.draftTitle).flat()) expect(`${locale}: ${line}`).toContain('{project}');
      expect(copy.push.smallHours.length).toBeGreaterThan(0);
      for (const { title } of copy.push.smallHours) expect(`${locale}: ${title}`).toContain('{time}');
      for (const { title } of copy.netDeletionCommit) {
        for (const form of Object.values(title)) expect(`${locale}: ${form}`).toContain('{count}');
      }
    });
  }
});
