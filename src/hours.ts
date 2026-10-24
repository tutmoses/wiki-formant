// hours.ts — a place's opening hours: how they read, a week to a few rows, and
// whether it is open at a given moment by its own clock. Pure, so a server
// render, a page's twin, its structured data and the visitor's browser all
// read them the same way. miow had them first; every app here has the
// `locations` block now.

import { toMapEmbedUrl } from './maps.js';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Each day's whole name, as schema.org and a screen reader say it. */
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** A time of day, 24-hour: "08:00", "17:30". A closing time at or before the opening one is the next morning's. */
export const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Where a place's clock is when it names none. */
export const DEFAULT_ZONE = 'Europe/London';

export type Hours = { days: Day[]; opens: string; closes: string };

export const isZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const WEEK = 7 * 1440;

/** "8am", "5:30pm", "noon", "midnight". */
function timeWords(t: string) {
  const m = minutes(t);
  if (m === 0) return 'midnight';
  if (m === 720) return 'noon';
  const h = Math.floor(m / 60) % 12 || 12;
  return `${h}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'am' : 'pm'}`;
}

/** Each opening as minutes into the week from Monday's midnight, an overnight one running into the next day. */
function spans(hours: Hours[]) {
  return hours
    .flatMap(h =>
      h.days.map(d => {
        const start = DAYS.indexOf(d) * 1440 + minutes(h.opens);
        const length = (minutes(h.closes) - minutes(h.opens) + 1440) % 1440 || 1440;
        return { start, end: start + length };
      }),
    )
    .sort((a, b) => a.start - b.start);
}

/**
 * The week as rows, neighbouring days that keep the same hours set as one:
 * "Mon–Fri 8am–6pm", "Sat 9am–4pm", "Sun Closed". `days` names each row's
 * days, so the visitor's own day can be marked.
 */
export function hoursRows(hours: Hours[]) {
  const day = DAYS.map(d =>
    hours
      .filter(h => h.days.includes(d))
      .sort((a, b) => a.opens.localeCompare(b.opens))
      .map(h => (h.opens === h.closes ? 'Open 24 hours' : `${timeWords(h.opens)}–${timeWords(h.closes)}`))
      .join(', '),
  );
  const rows: { days: Day[]; label: string; times: string }[] = [];
  day.forEach((times, i) => {
    const last = rows.at(-1);
    if (last && last.times === (times || 'Closed')) last.days.push(DAYS[i]!);
    else rows.push({ days: [DAYS[i]!], label: '', times: times || 'Closed' });
  });
  for (const r of rows) {
    const [first, last] = [DAYS.indexOf(r.days[0]!), DAYS.indexOf(r.days.at(-1)!)];
    r.label = r.days.length === 7 ? 'Every day' : first === last ? NAMES[first]! : last === first + 1 ? `${NAMES[first]}, ${NAMES[last]}` : `${NAMES[first]}–${NAMES[last]}`;
  }
  return rows;
}

/** The day of the week and the minute of it, by the clock at `zone`. */
export function clock(now: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const day = NAMES.indexOf(part('weekday'));
  return { day: DAYS[day]!, minute: day * 1440 + Number(part('hour')) * 60 + Number(part('minute')) };
}

/** Whether a place is open at `minute` into its week, and the words that say so: "Open · closes 6pm", "Closed · opens Mon 8am". */
export function openState(hours: Hours[], minute: number): { open: boolean; words: string } | null {
  const all = spans(hours);
  if (!all.length) return null;
  // Last week's overnight opening may still be running into this Monday, and this Sunday's into next week.
  const runs = all.flatMap(s => [-WEEK, 0, WEEK].map(w => ({ start: s.start + w, end: s.end + w })));
  const now = runs.find(s => s.start <= minute && minute < s.end);
  if (now) {
    // Openings that meet run on as one: a shop open round the clock never closes.
    let end = now.end;
    for (let next; (next = runs.find(s => s.start <= end && s.end > end)) && end - minute < WEEK; ) end = next.end;
    if (end - minute >= WEEK) return { open: true, words: 'Open 24 hours' };
    return { open: true, words: `Open · closes ${timeWords(clockTime(end))}` };
  }
  const next = all.map(s => (s.start > minute ? s.start : s.start + WEEK)).sort((a, b) => a - b)[0]!;
  const days = Math.floor(next / 1440) - Math.floor(minute / 1440);
  const when = days === 0 ? '' : days === 1 ? 'tomorrow ' : `${NAMES[Math.floor(next / 1440) % 7]} `;
  return { open: false, words: `Closed · opens ${when}${timeWords(clockTime(next))}` };
}

const clockTime = (minute: number) => {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** schema.org's OpeningHoursSpecification for each row of hours. */
export const hoursLd = (hours: Hours[]) =>
  hours.map(h => ({
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: h.days.map(d => `https://schema.org/${DAY_NAMES[DAYS.indexOf(d)]}`),
    opens: h.opens,
    closes: h.closes,
  }));

/** Where a place's address is on a map: the link it was given, or a search for its words. */
export const mapHref = (place: { address?: string; map?: string }) =>
  place.map || (place.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.address.replace(/\n+/g, ', '))}` : undefined);

/** A map of the place to set in the page, which needs no key: where its map link points, if that can be read, or else its address. */
export const mapEmbed = (place: { address: string; map?: string }) =>
  (place.map && toMapEmbedUrl(place.map)) || `https://maps.google.com/maps?q=${encodeURIComponent(place.address.replace(/\n+/g, ', '))}&z=15&output=embed`;
