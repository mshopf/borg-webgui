import { Temporal } from '@js-temporal/polyfill';
import type { BackupSchedule } from './management-schema';

/** Calendar-based scheduling: skip missing DST times, choose the first repeated time. */
export function nextOccurrence (schedule: BackupSchedule, after: Date): Date {
    const instant = Temporal.Instant.fromEpochMilliseconds (after.getTime ());
    const local = instant.toZonedDateTimeISO (schedule.timezone);
    const times = [...new Set (schedule.times)].sort ();
    for (let day = 0; day < 370; day++) {
        const date = local.toPlainDate ().add ({ days: day });
        if (schedule.frequency === 'weekly' && !schedule.weekdays.includes (date.dayOfWeek)) continue;
        if (schedule.frequency === 'monthly' && !schedule.monthdays.includes (date.day)) continue;
        for (const time of times) {
            const plain = date.toPlainDateTime (time);
            const candidate = plain.toZonedDateTime (schedule.timezone, { disambiguation: 'earlier' });
            // 'earlier' shifts missing wall-clock times back across the gap. Skip them.
            if (!candidate.toPlainDateTime ().equals (plain)) continue;
            if (candidate.epochMilliseconds > after.getTime ()) return new Date (candidate.epochMilliseconds);
        }
    }
    throw Error ('No scheduled time within the next year');
}
export function dueOccurrence (schedule: BackupSchedule, now: Date): Date | null {
    const next = nextOccurrence (schedule, new Date (now.getTime () - 60000));
    return next.getTime () <= now.getTime () ? next : null;
}
export function archiveTimestamp (date: Date): string {
    return date.toISOString ().slice (0, 19).replace ('T', '-').replaceAll (':', '');
}
