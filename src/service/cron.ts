import { EngineError } from '../errors.ts';

/**
 * Cron schedules: standard 5 fields (`m h dom mon dow`) or Quartz-style 6–7 fields
 * (`s m h dom mon dow [year]`, `?` allowed, optional trailing time zone). Seconds are ignored:
 * schedules fire at minute resolution.
 */
export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  /** Quartz `L` / `L-n` in day-of-month: the last day of the month, or n days before it. */
  lastDays: number[];
  months: Set<number>;
  weekdays: Set<number>;
  /** True when day-of-month is restricted (standard cron ORs dom and dow when both are restricted). */
  domRestricted: boolean;
  dowRestricted: boolean;
  /**
   * Minute and hour are both fixed (no `*`, `?` or step). Like Vixie cron, such jobs fire once when
   * a daylight-saving change repeats their local time, and once right after a change skips it;
   * interval jobs simply follow the wall clock.
   */
  fixedTime: boolean;
  timezone: string | undefined;
  source: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

function parseField(field: string, min: number, max: number, names?: string[], quartzDow = false): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  const restricted = !(field === '*' || field === '?');
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo: number;
    let hi: number;
    const value = (s: string) => {
      const lower = s.toLowerCase();
      const named = names?.indexOf(lower.slice(0, 3)) ?? -1;
      let n = named >= 0 && /^[a-z]+$/.test(lower) ? named + (names === MONTHS ? 1 : 0) : Number(s);
      if (quartzDow && named < 0) n -= 1; // Quartz: 1 = Sunday
      if (!Number.isInteger(n)) throw new Error(`bad value "${s}"`);
      return n === 7 && names === DAYS ? 0 : n;
    };
    if (rangePart === '*' || rangePart === '?') {
      lo = min;
      hi = max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-');
      lo = value(a!);
      hi = value(b!);
      if (names === DAYS && hi === 0) hi = 7;
    } else {
      lo = value(rangePart!);
      hi = stepPart === undefined ? lo : max;
    }
    if (lo < min || hi > (names === DAYS ? 7 : max) || lo > hi) throw new Error(`"${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(names === DAYS && v === 7 ? 0 : v);
  }
  return { values, restricted };
}

/** A cron field made only of month or weekday names (`FRI`, `MON-FRI`, `JAN/2`), not a time zone. */
function isNameField(field: string): boolean {
  return field.split(/[-/]/).every((part) => /^\d+$/.test(part) || (/^[a-z]+$/i.test(part) && (MONTHS.includes(part.slice(0, 3).toLowerCase()) || DAYS.includes(part.slice(0, 3).toLowerCase()))));
}

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the trailing field of a 6–8 field expression is a time zone rather than a cron field:
 * an IANA `Area/Location` name (`America/New_York`, `Etc/GMT+5`) or a zone name such as `UTC`,
 * `GMT` or `CET`. Weekday and month names (`0 15 10 ? * FRI`) are cron fields.
 */
function looksLikeTimeZone(field: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(field) || isNameField(field)) return false;
  return field.includes('/') || /^(utc|gmt|uct|z|zulu|universal|greenwich)$/i.test(field) || isTimeZone(field);
}

export function parseCron(expression: string, timezone?: string): CronSchedule {
  let text = expression.trim();
  text = MACROS[text.toLowerCase()] ?? text;
  let parts = text.split(/\s+/);
  let tz = timezone?.trim() || undefined;
  if (parts.length > 5 && looksLikeTimeZone(parts[parts.length - 1]!)) {
    const trailing = parts.pop();
    tz ??= trailing; // an explicit time zone setting wins over one written in the expression
  }
  let quartz = false;
  if (parts.length === 6 || parts.length === 7) {
    quartz = true;
    parts = parts.slice(1, 6); // drop seconds (and year)
  }
  if (parts.length !== 5) throw new EngineError('BAD_PAYLOAD', `Cron expression "${expression}" needs 5 fields (minute hour day month weekday)`);
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new EngineError('BAD_PAYLOAD', `Unknown time zone "${tz}"`);
    }
  }
  try {
    const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
    const lastDays: number[] = [];
    const domRest: string[] = [];
    for (const part of dom.split(',')) {
      const last = /^L(?:-(\d{1,2}))?$/i.exec(part);
      if (!last) domRest.push(part);
      else if (Number(last[1] ?? 0) > 30) throw new Error(`"${part}" is out of range L-0 to L-30`);
      else lastDays.push(Number(last[1] ?? 0));
    }
    const days = domRest.length ? parseField(domRest.join(','), 1, 31) : { values: new Set<number>(), restricted: true };
    const weekdays = parseField(dow, 0, 6, DAYS, quartz && /^\d/.test(dow));
    const interval = (field: string) => /^[*?]/.test(field) || field.includes('/');
    return {
      minutes: parseField(m, 0, 59).values, hours: parseField(h, 0, 23).values, days: days.values, lastDays, months: parseField(mon, 1, 12, MONTHS).values,
      weekdays: weekdays.values, domRestricted: days.restricted || lastDays.length > 0, dowRestricted: weekdays.restricted,
      fixedTime: !interval(m) && !interval(h), timezone: tz, source: expression,
    };
  } catch (e) {
    throw new EngineError('BAD_PAYLOAD', `Invalid cron expression "${expression}": ${(e as Error).message}`);
  }
}

interface Parts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(date: Date, timezone: string | undefined): Parts {
  if (!timezone || timezone === 'UTC') return utcParts(date);
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(timezone, fmt);
  }
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  // Weekday from the local calendar date, so it always agrees with year/month/day.
  return utcParts(new Date(Date.UTC(Number(map['year']), Number(map['month']) - 1, Number(map['day']), Number(map['hour']) % 24, Number(map['minute']))));
}

function utcParts(date: Date): Parts {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), weekday: date.getUTCDay() };
}

/** Local wall-clock time as minutes since the epoch, as if the zone were UTC. */
const wallMinutes = (p: Parts) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 60_000;
/** Local minus UTC offset at `t`, in minutes. */
const offsetAt = (t: number, timezone: string | undefined) => wallMinutes(partsIn(new Date(t), timezone)) - Math.floor(t / 60_000);
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function dayMatches(s: CronSchedule, p: Parts): boolean {
  if (!s.months.has(p.month)) return false;
  const dom = s.days.has(p.day) || (s.lastDays.length > 0 && s.lastDays.includes(daysInMonth(p.year, p.month) - p.day));
  const dow = s.weekdays.has(p.weekday);
  if (s.domRestricted && s.dowRestricted) return dom || dow;
  return dom && dow;
}

const fieldsMatch = (s: CronSchedule, p: Parts) => s.minutes.has(p.minute) && s.hours.has(p.hour) && dayMatches(s, p);

/**
 * Whether the schedule fires in the minute starting at `date`. Around daylight-saving changes a
 * fixed-time job fires once: on the first of two occurrences of a repeated local time, and at
 * the first instant after a skipped local time.
 */
export function matches(schedule: CronSchedule, date: Date): boolean {
  const t = Math.floor(date.getTime() / 60_000) * 60_000;
  const p = partsIn(new Date(t), schedule.timezone);
  if (fieldsMatch(schedule, p)) return !(schedule.fixedTime && repeatsEarlierTime(t, p, schedule.timezone));
  if (!schedule.fixedTime || !schedule.timezone || schedule.timezone === 'UTC') return false;
  // First minute after the clocks jumped forward: fire jobs whose local time was skipped.
  const now = wallMinutes(p);
  const before = wallMinutes(partsIn(new Date(t - 60_000), schedule.timezone));
  for (let w = before + 1; w < now; w++) if (fieldsMatch(schedule, utcParts(new Date(w * 60_000)))) return true;
  return false;
}

/** True when the local time at `t` already occurred earlier (the clocks were just set back). */
function repeatsEarlierTime(t: number, p: Parts, timezone: string | undefined): boolean {
  if (!timezone || timezone === 'UTC') return false;
  const shift = offsetAt(t - 3 * 3_600_000, timezone) - offsetAt(t, timezone);
  return shift > 0 && wallMinutes(partsIn(new Date(t - shift * 60_000), timezone)) === wallMinutes(p);
}

/** The first minute in (from, to] at which the zone's UTC offset differs from its offset at `from`. */
function offsetChange(from: number, to: number, timezone: string | undefined): number | undefined {
  if (!timezone || timezone === 'UTC') return undefined;
  const base = offsetAt(from, timezone);
  if (offsetAt(to, timezone) === base) return undefined;
  let lo = from;
  let hi = to;
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (offsetAt(mid, timezone) === base) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Next minute (after `from`) the schedule fires, searching up to five years ahead (leap days).
 * Skips ahead by local day, hour and minute, but never across a UTC-offset change, so 23- and
 * 25-hour days and the instants right after a change are handled by `matches`.
 */
export function nextRun(schedule: CronSchedule, from = new Date()): Date | undefined {
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 5 * 366 * 86_400_000;
  const minutes = [...schedule.minutes].sort((a, b) => a - b);
  while (t < limit) {
    if (matches(schedule, new Date(t))) return new Date(t);
    const p = partsIn(new Date(t), schedule.timezone);
    let step: number;
    if (!dayMatches(schedule, p)) step = 24 * 60 - (p.hour * 60 + p.minute);
    else if (!schedule.hours.has(p.hour)) step = 60 - p.minute;
    else step = (minutes.find((m) => m > p.minute) ?? 60) - p.minute;
    const next = t + Math.max(step, 1) * 60_000;
    t = offsetChange(t, next, schedule.timezone) ?? next;
  }
  return undefined;
}
