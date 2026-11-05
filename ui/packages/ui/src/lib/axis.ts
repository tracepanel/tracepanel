// A time axis' ticks: round steps across a duration, said in one unit. The strip's axis and the panel's draw them.

/** A tick on a time axis: where (a share of the time) and what it says. */
export interface Tick {
  at: number;
  label: string;
}

/** The round steps an axis counts in, of a power of ten. */
const STEPS = [1, 2, 2.5, 5, 10];

/** At least this many steps across the axis: 3 to 6 of them, whatever the time. */
const MIN_STEPS = 3;

/**
 * The time axis' ticks: from 0 by the largest round step (1, 2, 2.5 or 5 of a power of ten) that fits MIN_STEPS
 * times, none past its end; all said in one unit with the decimals the step needs ("0.5 ms", "1.0 ms"), so they read
 * evenly spaced and no two the same.
 */
export function axisTicks(duration: number): Tick[] {
  const total = Math.max(duration, 1);
  const power = 10 ** Math.floor(Math.log10(total / MIN_STEPS));
  const fits = [...STEPS, ...STEPS.map((each) => each / 10)]
    .map((each) => each * power)
    .filter((each) => total / each >= MIN_STEPS - 1e-9);
  const step = Math.max(Math.max(...fits), 1);
  const [unit, scale] = step >= 100_000 && total >= 1_000_000 ? ["s", 1e6] : step >= 100 ? ["ms", 1e3] : ["µs", 1];
  const said = step / scale;
  let decimals = 0;
  while (decimals < 3 && Math.abs(Math.round(said * 10 ** decimals) - said * 10 ** decimals) > 1e-6) decimals += 1;
  const ticks: Tick[] = [];
  for (let n = 0; n * step <= total * (1 + 1e-9); n += 1) {
    ticks.push({ at: (n * step) / total, label: n === 0 ? "0" : `${(n * said).toFixed(decimals)} ${unit}` });
  }
  return ticks;
}
