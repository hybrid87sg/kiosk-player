// Working hours of a location: when its screens play, and when they go dark.
//
// Stored as one entry per day, e.g.
//   { mon: { open: "08:00", close: "18:00" }, ..., sun: null }
// where null means closed all day. A close time earlier than the open time
// runs past midnight (e.g. 18:00 to 02:00). No hours at all (null) means the
// location is open all the time.
//
// Times are the TV's own local time; each TV judges open or closed with its
// own clock. The server uses the same rules (with the TV's time zone) to
// decide whether a silent screen should have been on.

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Checks hours from the web page. Returns { hours } (null = always open) or { error }. */
function checkHours(input) {
  if (input === null || input === undefined) return { hours: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'hours must be an object with one entry per day' };
  const hours = {};
  for (const day of DAYS) {
    const entry = input[day];
    if (entry === null || entry === undefined) {
      hours[day] = null;
      continue;
    }
    if (!TIME.test(String(entry.open)) || !TIME.test(String(entry.close))) {
      return { error: `${DAY_NAMES[day]}: use times like 08:00 and 18:00` };
    }
    if (entry.open === entry.close) return { error: `${DAY_NAMES[day]}: opening and closing times can't be the same` };
    hours[day] = { open: entry.open, close: entry.close };
  }
  return { hours };
}

/** "Mon–Fri 08:00–18:00 · Sat 10:00–16:00 · Sun closed", or "Always on". */
function summarizeHours(hours) {
  if (!hours) return 'Always on';
  const label = (e) => (e ? `${e.open}–${e.close}` : 'closed');
  const parts = [];
  let i = 0;
  while (i < DAYS.length) {
    let j = i;
    while (j + 1 < DAYS.length && label(hours[DAYS[j + 1]]) === label(hours[DAYS[i]])) j++;
    const days = i === j ? DAY_NAMES[DAYS[i]] : `${DAY_NAMES[DAYS[i]]}–${DAY_NAMES[DAYS[j]]}`;
    parts.push(`${days} ${label(hours[DAYS[i]])}`);
    i = j + 1;
  }
  return parts.join(' · ');
}

/** The weekday ("mon"…) and minute of the day at [ms] in [timeZone]. */
function localTime(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return { day: get('weekday').toLowerCase().slice(0, 3), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Is a location with these hours open at [ms], in [timeZone]? */
function isOpenAt(hours, ms, timeZone) {
  if (!hours) return true;
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = undefined; // unknown time zone from a TV: use this server's
  }
  const { day, minute } = localTime(ms, zone);
  const today = hours[day];
  const yesterday = hours[DAYS[(DAYS.indexOf(day) + 6) % 7]];
  if (today) {
    const open = minutes(today.open);
    const close = minutes(today.close);
    if (close > open ? minute >= open && minute < close : minute >= open) return true;
  }
  // Yesterday's hours may run past midnight into today.
  if (yesterday && minutes(yesterday.close) < minutes(yesterday.open) && minute < minutes(yesterday.close)) return true;
  return false;
}

module.exports = { DAYS, checkHours, summarizeHours, isOpenAt };
