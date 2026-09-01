const RELATIVE_TIME_UNITS: readonly [
  upperBoundMs: number,
  unitMs: number,
  unit: Intl.RelativeTimeFormatUnit,
][] = [
  [60_000, 1_000, "second"],
  [3_600_000, 60_000, "minute"],
  [86_400_000, 3_600_000, "hour"],
  [604_800_000, 86_400_000, "day"],
  [2_592_000_000, 604_800_000, "week"],
  [31_536_000_000, 2_592_000_000, "month"],
  [Number.POSITIVE_INFINITY, 31_536_000_000, "year"],
];

export function humanTimestamp(
  value: string,
  now: number | Date = Date.now(),
  locales?: Intl.LocalesArgument,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const differenceMs = date.getTime() - new Date(now).getTime();
  const [, unitMs, unit] = RELATIVE_TIME_UNITS.find(
    ([upperBoundMs]) => Math.abs(differenceMs) < upperBoundMs,
  )!;
  const magnitude = Math.round(Math.abs(differenceMs) / unitMs);
  const relativeValue = differenceMs < 0 ? -magnitude : magnitude;
  return new Intl.RelativeTimeFormat(locales, { numeric: "auto" }).format(relativeValue, unit);
}
