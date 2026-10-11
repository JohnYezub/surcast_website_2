// Sample data for the #compare chart: 7 days × 4 steps of wave height (m) at
// Uluwatu from the four models. Plausible, not live: the models track each
// other Mon–Wed and spread apart later in the week, the way real runs do.
import { mulberry32 } from '../lib/motion-geometry';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const STEPS = DAYS.length * 4; // 28

export const MODELS = [
  { id: 'ecmwf', name: 'ECMWF', color: 'var(--m-ecmwf)', k: 0.05 },
  { id: 'gfs', name: 'GFS', color: 'var(--m-gfs)', k: 0.7 },
  { id: 'mfwam', name: 'MFWAM', color: 'var(--m-mfwam)', k: -0.6 },
  { id: 'dwd', name: 'DWD', color: 'var(--m-dwd)', k: 0.3 },
] as const;

const base = (t: number) =>
  1.55 + 0.45 * Math.sin((t / (STEPS - 1)) * Math.PI * 2 * 0.9 - 0.6) + 0.12 * Math.sin(0.9 * t);
const spread = (t: number) => 0.04 + 0.55 * Math.pow(t / (STEPS - 1), 1.7);

const rnd = mulberry32(20261011 + 3);

/** Wave height per model, rounded to cm. */
export const series: Record<(typeof MODELS)[number]['id'], number[]> = Object.fromEntries(
  MODELS.map(({ id, k }) => {
    const phi = rnd() * Math.PI * 2;
    const values = Array.from({ length: STEPS }, (_, t) => {
      const v = base(t) + spread(t) * (k + 0.35 * Math.sin(0.55 * t + phi));
      return Math.round(v * 100) / 100;
    });
    return [id, values];
  }),
) as Record<(typeof MODELS)[number]['id'], number[]>;
