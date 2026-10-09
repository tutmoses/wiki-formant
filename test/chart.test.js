import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketChart, chartSteps, formatChartValue } from 'wiki-formant/chart';
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

test('the stats page takes all time as ?days=all', () => {
  assert.equal(statsDays('all'), Infinity);
  assert.equal(statsDays('365'), 365);
  assert.equal(statsDays('Infinity'), 30);
});
