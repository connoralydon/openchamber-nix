/**
 * The moments the easter eggs react to, read from the viewer's local clock:
 * a push at 2am means 2am where the person sits, whatever the server thinks.
 */

export type Occasion = 'halloween' | 'newYearsEve' | 'newYearsDay';

export const occasionOf = (date: Date): Occasion | null => {
  const month = date.getMonth();
  const day = date.getDate();
  if (month === 9 && day === 31) return 'halloween';
  if (month === 11 && day === 31) return 'newYearsEve';
  if (month === 0 && day === 1) return 'newYearsDay';
  return null;
};

/** Friday from 18:00 to midnight. */
export const isFridayEvening = (date: Date): boolean => date.getDay() === 5 && date.getHours() >= 18;

/** Midnight to 05:00: a push here gets the late-night toast. */
export const isSmallHours = (date: Date): boolean => date.getHours() < 5;

/** 01:00 to 05:00: a new chat this late gets the "still up?" heading. */
export const isDeepNight = (date: Date): boolean => date.getHours() >= 1 && date.getHours() < 5;
