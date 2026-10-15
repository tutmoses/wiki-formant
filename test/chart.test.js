import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketChart, chartSteps, formatChartValue, placeMarkers, stepDecimals } from 'wiki-formant/chart';
import { statsDays } from 'wiki-formant/stats';

const DAY = 86_400;
const at = iso => Date.parse(iso) / 1000;
const days = (from, values) => values.map((value, i) => ({ time: at(from) + i * DAY, value }));

test('a week starts on a Monday and a month on its first, in UTC', () => {
  // 2026-10-04 is a Sunday, 2026-10-05 a Monday.
  const points = days('2026-09-30', [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(bucketChart(points, 'week', 'last'), [
    { time: at('2026-09-28'), value: 5 },
    { time: at('2026-10-05'), value: 7 },
  ]);
  assert.deepEqual(bucketChart(points, 'month', 'last'), [
    { time: at('2026-09-01'), value: 1 },
    { time: at('2026-10-01'), value: 7 },
  ]);
});

test('a week of candles opens on its first, closes on its last and sums its volume', () => {
  const points = [
    { time: at('2026-09-28'), open: 1, high: 3, low: 1, value: 2, volume: 10 },
    { time: at('2026-09-29'), open: 2, high: 5, low: 0.5, value: 4, volume: 5 },
    { time: at('2026-10-05'), open: 4, high: 4, low: 4, value: 4, volume: 0 },
  ];
  assert.deepEqual(bucketChart(points, 'week', 'last'), [
    { time: at('2026-09-28'), open: 1, high: 5, low: 0.5, value: 4, volume: 15 },
    { time: at('2026-10-05'), open: 4, high: 4, low: 4, value: 4, volume: 0 },
  ]);
});

test('counts take the mean of their days, so a week in progress keeps its level', () => {
  const points = days('2026-09-28', [10, 20, 30, 40, 50, 60, 70, 8]);
  assert.deepEqual(bucketChart(points, 'week', 'mean').map(p => p.value), [40, 8]);
});

test('a step is offered once it makes four points; the default makes 200 or fewer', () => {
  assert.deepEqual(chartSteps(7 * DAY), { steps: ['day'], fallback: 'day' });
  assert.deepEqual(chartSteps(30 * DAY), { steps: ['day', 'week'], fallback: 'day' });
  assert.deepEqual(chartSteps(365 * DAY), { steps: ['day', 'week', 'month'], fallback: 'week' });
  assert.deepEqual(chartSteps(3 * 365 * DAY), { steps: ['day', 'week', 'month'], fallback: 'week' });
  assert.deepEqual(chartSteps(5 * 365 * DAY), { steps: ['day', 'week', 'month'], fallback: 'month' });
});

test('values are compact from a thousand and four figures below', () => {
  assert.equal(formatChartValue(1234567), '1.23M');
  assert.equal(formatChartValue(0.012345), '0.01235');
  assert.equal(formatChartValue(12), '12');
});

test('an axis tick is written to its step, so neighbours never read alike', () => {
  assert.equal(stepDecimals(0.25), 2);
  assert.equal(stepDecimals(0.0005), 4);
  assert.equal(stepDecimals(0.30000000000000004 - 0.25), 2);
  assert.equal(stepDecimals(5000), 0);
  assert.deepEqual([4.84e9, 4.845e9, 4.85e9].map(n => formatChartValue(n, 5e6)), ['4.84B', '4.845B', '4.85B']);
  assert.deepEqual([1500, 1000, 500, 0].map(n => formatChartValue(n, 500)), ['1.5K', '1K', '500', '0']);
  assert.deepEqual([0.0035, 0.0005].map(n => formatChartValue(n, 0.0005)), ['0.0035', '0.0005']);
});

test('the stats page takes all time as ?days=all', () => {
  assert.equal(statsDays('all'), Infinity);
  assert.equal(statsDays('365'), 365);
  assert.equal(statsDays('Infinity'), 30);
});

test('a marker sits on the point that holds it; two on one point share it', () => {
  const daily = days('2026-09-28', [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(placeMarkers([{ time: at('2026-09-30T12:00:00Z'), label: 'Halt' }], daily, 'day'), [
    { time: at('2026-09-30'), label: 'Halt' },
  ]);
  const weekly = bucketChart(daily, 'week', 'mean');
  assert.deepEqual(placeMarkers([
    { time: at('2026-10-01'), label: 'A' },
    { time: at('2026-09-29'), label: 'B' },
    { time: at('2026-10-05'), label: 'C' },
  ], weekly, 'week'), [
    { time: at('2026-09-28'), label: 'B · A' },
    { time: at('2026-10-05'), label: 'C' },
  ]);
});

test('a marker outside the points drawn is left off', () => {
  const daily = days('2026-09-28', [1, 2, 3]);
  assert.deepEqual(placeMarkers([{ time: at('2026-09-01'), label: 'Before' }, { time: at('2026-10-01'), label: 'After' }], daily, 'day'), []);
  assert.deepEqual(placeMarkers([{ time: at('2026-09-28'), label: 'X' }], [], 'day'), []);
});
