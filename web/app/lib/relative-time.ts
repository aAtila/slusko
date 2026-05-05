const secondMs = 1000;
const minuteMs = 60 * secondMs;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const monthMs = 30 * dayMs;
const yearMs = 12 * monthMs;

export function formatRelativeTimeFromNow(isoDate: string, nowMs: number) {
  const dateMs = Date.parse(isoDate);

  if (Number.isNaN(dateMs)) {
    return "Unknown date";
  }

  const elapsedMs = Math.max(0, nowMs - dateMs);

  if (elapsedMs < minuteMs) {
    return "just now";
  }

  if (elapsedMs < hourMs) {
    return formatUnit(Math.floor(elapsedMs / minuteMs), "minute");
  }

  if (elapsedMs < dayMs) {
    return formatUnit(Math.floor(elapsedMs / hourMs), "hour");
  }

  if (elapsedMs < monthMs) {
    return formatUnit(Math.floor(elapsedMs / dayMs), "day");
  }

  if (elapsedMs < yearMs) {
    return formatUnit(Math.floor(elapsedMs / monthMs), "month");
  }

  return formatUnit(Math.floor(elapsedMs / yearMs), "year");
}

function formatUnit(value: number, unit: string) {
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}
