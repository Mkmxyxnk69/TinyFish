import { CronExpressionParser } from "cron-parser";
export function nextScheduledRun(schedule: string, from = new Date()) {
  const match = schedule.match(/^CRON_TZ=([^ ]+)\s+(.+)$/);
  return CronExpressionParser.parse(match ? match[2] : schedule, {
    currentDate: from,
    tz: match?.[1] || "UTC",
  })
    .next()
    .toDate();
}
export function validateSchedule(schedule: string, topic = false) {
  const first = nextScheduledRun(schedule),
    second = nextScheduledRun(schedule, first);
  if (topic && second.getTime() - first.getTime() < 30 * 60000)
    throw new Error("Topic Monitors must run at least 30 minutes apart");
  return first.toISOString();
}
