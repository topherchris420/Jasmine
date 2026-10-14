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
  months: Set<number>;
  weekdays: Set<number>;
  /** True when day-of-month is restricted (standard cron ORs dom and dow when both are restricted). */
  domRestricted: boolean;
  dowRestricted: boolean;
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

export function parseCron(expression: string, timezone?: string): CronSchedule {
  let text = expression.trim();
  text = MACROS[text.toLowerCase()] ?? text;
  let parts = text.split(/\s+/);
  let tz = timezone?.trim() || undefined;
  if (parts.length > 5 && /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(parts[parts.length - 1]!) && !/^(\*|\?)$/.test(parts[parts.length - 1]!) && !MONTHS.includes(parts[parts.length - 1]!.toLowerCase().slice(0, 3))) {
    tz ??= parts.pop();
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
    const days = parseField(dom.replace(/L/g, '31'), 1, 31);
    const weekdays = parseField(dow, 0, 6, DAYS, quartz && /^\d/.test(dow));
    return {
      minutes: parseField(m, 0, 59).values, hours: parseField(h, 0, 23).values, days: days.values, months: parseField(mon, 1, 12, MONTHS).values,
      weekdays: weekdays.values, domRestricted: days.restricted, dowRestricted: weekdays.restricted, timezone: tz, source: expression,
    };
  } catch (e) {
    throw new EngineError('BAD_PAYLOAD', `Invalid cron expression "${expression}": ${(e as Error).message}`);
  }
}

interface Parts { minute: number; hour: number; day: number; month: number; weekday: number }

function partsIn(date: Date, timezone: string | undefined): Parts {
  if (!timezone || timezone === 'UTC') {
    return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth() + 1, weekday: date.getUTCDay() };
  }
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short' });
  const map = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { minute: Number(map['minute']), hour: Number(map['hour']) % 24, day: Number(map['day']), month: Number(map['month']), weekday: DAYS.indexOf(String(map['weekday']).toLowerCase().slice(0, 3)) };
}

export function matches(schedule: CronSchedule, date: Date): boolean {
  const p = partsIn(date, schedule.timezone);
  if (!schedule.minutes.has(p.minute) || !schedule.hours.has(p.hour) || !schedule.months.has(p.month)) return false;
  const dom = schedule.days.has(p.day);
  const dow = schedule.weekdays.has(p.weekday);
  if (schedule.domRestricted && schedule.dowRestricted) return dom || dow;
  return dom && dow;
}

/** Next minute (after `from`) the schedule fires, searching up to five years ahead (leap days). */
export function nextRun(schedule: CronSchedule, from = new Date()): Date | undefined {
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const limit = t.getTime() + 5 * 366 * 86_400_000;
  while (t.getTime() < limit) {
    const p = partsIn(t, schedule.timezone);
    const dayOk = schedule.months.has(p.month) && (schedule.domRestricted && schedule.dowRestricted
      ? schedule.days.has(p.day) || schedule.weekdays.has(p.weekday)
      : schedule.days.has(p.day) && schedule.weekdays.has(p.weekday));
    if (!dayOk) t.setTime(t.getTime() + ((24 - p.hour) * 60 - p.minute) * 60_000);
    else if (!schedule.hours.has(p.hour)) t.setTime(t.getTime() + (60 - p.minute) * 60_000);
    else if (!schedule.minutes.has(p.minute)) t.setTime(t.getTime() + 60_000);
    else return t;
  }
  return undefined;
}
