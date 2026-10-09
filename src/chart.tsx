'use client';

// chart.tsx — one time series as an area chart: the token, activity and visitor
// charts on every site. Ranges run from 24 hours to all time, and a long range
// steps by day, week or month, so three years do not draw as a thousand points.
// A price that carries its open, high and low can be drawn as candles, and one
// that carries volume gets a volume pane under it. `lightweight-charts` is
// loaded on mount, so the page paints without it. Every colour is the canvas
// box's own `color`, its axis `--chart-axis`, and a candle `--chart-up` or
// `--chart-down`, each if set.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AutoscaleInfo, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';

/**
 * One value at a time in Unix seconds, UTC. A price may carry the rest of its
 * candle, `value` being the close, and the volume traded in it.
 */
export type ChartPoint = { time: number; value: number; open?: number; high?: number; low?: number; volume?: number };
export type ChartRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';
/** What a loader is asked for: hours for 24H, four hours for 7D, days for every longer range. */
export type ChartResolution = 'hour' | '4h' | 'day';
/** How a range of days is drawn: each day, or a point per week or month. */
export type ChartStep = 'day' | 'week' | 'month';
/** Points by resolution, from `from` (Unix seconds, 0 for all time), oldest first. */
export type ChartLoader = (resolution: ChartResolution, from: number) => Promise<readonly ChartPoint[]>;

const DAY = 86_400;
const RANGE: Record<ChartRange, { label: string; span: number; resolution: ChartResolution }> = {
  '24h': { label: '24H', span: DAY, resolution: 'hour' },
  '7d': { label: '7D', span: 7 * DAY, resolution: '4h' },
  '30d': { label: '30D', span: 30 * DAY, resolution: 'day' },
  '90d': { label: '90D', span: 90 * DAY, resolution: 'day' },
  '1y': { label: '1Y', span: 365 * DAY, resolution: 'day' },
  all: { label: 'All', span: Infinity, resolution: 'day' },
};
const STEP: Record<ChartStep, { label: string; span: number }> = {
  day: { label: 'D', span: DAY },
  week: { label: 'W', span: 7 * DAY },
  month: { label: 'M', span: 30.44 * DAY },
};

/** Every range, shortest first. A chart fed daily points offers the ones from 30D up. */
export const CHART_RANGES: readonly ChartRange[] = ['24h', '7d', '30d', '90d', '1y', 'all'];
const DAILY_RANGES: readonly ChartRange[] = ['30d', '90d', '1y', 'all'];

/** A step is offered once it makes four points, and the default is the finest that makes 200 or fewer. */
export function chartSteps(span: number): { steps: ChartStep[]; fallback: ChartStep } {
  const steps = (['day', 'week', 'month'] as const).filter(s => s === 'day' || span / STEP[s].span >= 4);
  return { steps, fallback: steps.find(s => span / STEP[s].span <= 200) ?? steps.at(-1)! };
}

/** The UTC day, Monday or first of the month a time falls in. */
function bucketStart(time: number, step: ChartStep): number {
  const day = Math.floor(time / DAY);
  if (step === 'day') return day * DAY;
  // 1 January 1970 was a Thursday, three days after a Monday.
  if (step === 'week') return (day - ((day + 3) % 7)) * DAY;
  const d = new Date(time * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

/**
 * Points, oldest first, one per step. A price keeps the last value in each
 * step, as a candle does its close: the first open, the highest high, the
 * lowest low. A count takes the mean of its days, so the week in progress does
 * not read as a collapse. Volume is summed.
 */
export function bucketChart(points: readonly ChartPoint[], step: ChartStep, aggregate: 'last' | 'mean'): ChartPoint[] {
  const out: ChartPoint[] = [];
  let n = 0;
  for (const p of points) {
    const start = bucketStart(p.time, step);
    const last = out.at(-1);
    if (last?.time !== start) {
      out.push({ ...p, time: start });
      n = 1;
      continue;
    }
    if (aggregate === 'last') last.value = p.value;
    else last.value += (p.value - last.value) / ++n;
    if (last.high !== undefined && p.high !== undefined) last.high = Math.max(last.high, p.high);
    if (last.low !== undefined && p.low !== undefined) last.low = Math.min(last.low, p.low);
    if (p.volume !== undefined) last.volume = (last.volume ?? 0) + p.volume;
  }
  return out;
}

const isCandle = (p: ChartPoint) => p.open !== undefined && p.high !== undefined && p.low !== undefined;

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
const precise = new Intl.NumberFormat('en', { maximumSignificantDigits: 4 });
/** Compact from a thousand up, four significant figures below. */
export const formatChartValue = (n: number) => (Math.abs(n) >= 1e3 ? compact.format(n) : precise.format(n));

/**
 * A CSS colour at an opacity, as the rgba() the chart's parser reads. Drawn to
 * a pixel and read back, because a site's colour may be oklch() or a named one.
 */
function rgba(colour: string, alpha = 1): string {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return colour;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  return `rgba(${Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)).join(', ')}, ${alpha})`;
}

const fromZeroScale = (base: () => AutoscaleInfo | null) => {
  const info = base();
  if (info?.priceRange) info.priceRange.minValue = 0;
  return info;
};

export interface TimeChartProps {
  /** Daily points, oldest first, or a loader for every resolution the ranges need. */
  series: readonly ChartPoint[] | ChartLoader;
  /** Read by assistive technology, as the chart's name. */
  label: string;
  /** The ranges offered. A single one draws no buttons and shows every point. */
  ranges?: readonly ChartRange[];
  /** The range shown first. */
  range?: ChartRange;
  /** A week or month of prices keeps its last; of counts, the mean of its days. */
  aggregate?: 'last' | 'mean';
  /** The value axis starts at zero, so a quiet week does not read as a collapse. */
  fromZero?: boolean;
  /** The value axis and crosshair label. Read on every draw, so it need not be stable. */
  format?: (n: number) => string;
  /** Open on candles, where the points carry them. A Line/Candles toggle shows either way. */
  candles?: boolean;
  /** In pixels. Otherwise the stylesheet's `--chart-height`, else 15rem. */
  height?: number;
  className?: string;
}

type Loaded = { resolution: ChartResolution; points: readonly ChartPoint[] } | { resolution: ChartResolution; error: string };

type Series = {
  api: IChartApi;
  area: ISeriesApi<'Area'>;
  candle: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'> | null;
  addVolume: () => ISeriesApi<'Histogram'>;
  up: string;
  down: string;
};

/**
 * A time series with its range, step and style buttons. The buttons are
 * `.chart-controls button[aria-pressed]`, and a site's stylesheet gives them
 * and the box their look; the line and fill are the canvas box's `color`.
 */
export function TimeChart({
  series,
  label,
  ranges = typeof series === 'function' ? CHART_RANGES : DAILY_RANGES,
  range: initial = ranges.includes('30d') ? '30d' : ranges[0]!,
  aggregate = 'last',
  fromZero = false,
  format = formatChartValue,
  candles: initialCandles = false,
  height,
  className,
}: TimeChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<Series | null>(null);
  const formatRef = useRef(format);
  formatRef.current = format;
  const [ready, setReady] = useState(false);
  const [range, setRange] = useState(initial);
  const [step, setStep] = useState<ChartStep | null>(null);
  const [candles, setCandles] = useState(initialCandles);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const resolution = RANGE[range].resolution;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let disposed = false;
    import('lightweight-charts').then(({ createChart, AreaSeries, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, LineStyle, LineType }) => {
      if (disposed) return;
      const style = getComputedStyle(el);
      const axis = style.getPropertyValue('--chart-axis').trim();
      const ink = rgba(style.color);
      const up = rgba(style.getPropertyValue('--chart-up').trim() || style.color);
      const down = rgba(style.getPropertyValue('--chart-down').trim() || style.color, style.getPropertyValue('--chart-down').trim() ? 1 : 0.45);
      const priceFormat = { type: 'custom', formatter: (n: number) => formatRef.current(n), minMove: 1e-12 } as const;
      const guide = { color: rgba(style.color, 0.4), width: 1, style: LineStyle.Dotted, labelBackgroundColor: ink } as const;
      const api = createChart(el, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: axis ? rgba(axis) : rgba(style.color, 0.7),
          fontFamily: style.fontFamily,
          fontSize: parseFloat(style.fontSize) || 11,
        },
        grid: { vertLines: { color: rgba(axis || style.color, 0.1) }, horzLines: { color: rgba(axis || style.color, 0.1) } },
        crosshair: { mode: CrosshairMode.Magnet, vertLine: guide, horzLine: guide },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.1 } },
        timeScale: { borderVisible: false, secondsVisible: false },
        handleScroll: false,
        handleScale: false,
      });
      const area = api.addSeries(AreaSeries, {
        lineColor: ink,
        topColor: rgba(style.color, 0.4),
        bottomColor: rgba(style.color, 0.02),
        lineWidth: 2,
        lineType: LineType.Curved,
        crosshairMarkerBackgroundColor: ink,
        crosshairMarkerBorderColor: ink,
        priceFormat,
        ...(fromZero && { autoscaleInfoProvider: fromZeroScale }),
      });
      const candle = api.addSeries(CandlestickSeries, {
        visible: false,
        upColor: up,
        downColor: down,
        borderUpColor: up,
        borderDownColor: down,
        wickUpColor: up,
        wickDownColor: down,
        priceFormat,
      });
      // The chart cannot be scrolled or zoomed, so every size it takes shows every point,
      // the first included: data drawn before autoSize has measured the box fits nothing.
      api.timeScale().subscribeSizeChange(() => api.timeScale().fitContent());
      // Volume takes a pane of its own under the price, a fifth of the height.
      const addVolume = () => {
        const volume = api.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
        api.panes()[0]?.setStretchFactor(4);
        api.panes()[1]?.setStretchFactor(1);
        return volume;
      };
      chart.current = { api, area, candle, volume: null, addVolume, up, down };
      setReady(true);
    });
    return () => {
      disposed = true;
      chart.current?.api.remove();
      chart.current = null;
      setReady(false);
    };
  }, [fromZero]);

  // One request per resolution for the life of the loader: every range from 30D up reads the same days.
  const cache = useRef(new Map<ChartResolution, Promise<readonly ChartPoint[]>>());
  useEffect(() => {
    cache.current.clear();
  }, [series]);
  useEffect(() => {
    if (typeof series !== 'function') return;
    let current = true;
    let request = cache.current.get(resolution);
    if (!request) {
      const now = Math.floor(Date.now() / 1000);
      request = series(resolution, resolution === 'day' ? 0 : now - RANGE[range].span);
      cache.current.set(resolution, request);
      request.catch(() => cache.current.delete(resolution));
    }
    request.then(
      points => current && setLoaded({ resolution, points }),
      (e: unknown) => current && setLoaded({ resolution, error: e instanceof Error ? e.message : 'The chart could not load' }),
    );
    return () => {
      current = false;
    };
  }, [series, resolution, range]);

  const source = useMemo<Loaded | null>(
    () => (typeof series === 'function' ? (loaded?.resolution === resolution ? loaded : null) : { resolution: 'day', points: series }),
    [series, loaded, resolution],
  );
  const points = source && 'points' in source ? source.points : null;

  const view = useMemo(() => {
    if (!points?.length) return null;
    const end = points.at(-1)!.time;
    const span = RANGE[range].span;
    const windowed = span === Infinity || ranges.length < 2 ? points : points.filter(p => p.time > Date.now() / 1000 - span);
    const drawn = (shown: readonly ChartPoint[], steps: ChartStep[], step: ChartStep | null) => ({
      shown,
      steps,
      step,
      ohlc: aggregate === 'last' && shown.length > 0 && shown.every(isCandle),
      volume: shown.some(p => p.volume !== undefined),
    });
    if (resolution !== 'day' || !windowed.length) return drawn(windowed, [], null);
    const { steps, fallback } = chartSteps(end - windowed[0]!.time);
    const chosen = step && steps.includes(step) ? step : fallback;
    return drawn(chosen === 'day' ? windowed : bucketChart(windowed, chosen, aggregate), steps, chosen);
  }, [points, range, ranges.length, resolution, step, aggregate]);

  // While a resolution loads, the last one stays under the skeleton; an empty or failed one clears it.
  useEffect(() => {
    const c = chart.current;
    if (!ready || !c || !source) return;
    const shown = view?.shown ?? [];
    const asCandles = candles && !!view?.ohlc;
    const time = (p: ChartPoint) => p.time as UTCTimestamp;
    c.api.applyOptions({ timeScale: { timeVisible: source.resolution !== 'day' } });
    c.area.applyOptions({ visible: !asCandles });
    c.candle.applyOptions({ visible: asCandles });
    c.area.setData(asCandles ? [] : shown.map(p => ({ time: time(p), value: p.value })));
    c.candle.setData(asCandles ? shown.map(p => ({ time: time(p), open: p.open!, high: p.high!, low: p.low!, close: p.value })) : []);
    if (view?.volume && !c.volume) c.volume = c.addVolume();
    else if (!view?.volume && c.volume) {
      c.api.removeSeries(c.volume);
      c.volume = null;
      if (c.api.panes().length > 1) c.api.removePane(1);
    }
    c.volume?.setData(
      shown.map((p, i) => {
        const rising = p.value >= (p.open ?? shown[i - 1]?.value ?? p.value);
        return { time: time(p), value: p.volume ?? 0, color: (rising ? c.up : c.down).replace(/[\d.]+\)$/, '0.5)') };
      }),
    );
    c.api.timeScale().fitContent();
  }, [ready, source, view, candles]);

  const status = source && 'error' in source ? source.error : points && !view?.shown.length ? 'No data in this range' : null;

  return (
    <figure className={className ? `chart ${className}` : 'chart'}>
      <div ref={box} className="chart-canvas" role="img" aria-label={label} style={height ? { height } : undefined} />
      {(!ready || (!points && !status)) && <div className="chart-status skeleton" aria-hidden />}
      {status && <p className="chart-status">{status}</p>}
      {(ranges.length > 1 || (view && (view.steps.length > 1 || view.ohlc))) && (
        <div className="chart-controls">
          {ranges.length > 1 && (
            <div role="group" aria-label="Range">
              {ranges.map(r => (
                <button key={r} type="button" aria-pressed={r === range} onClick={() => { setRange(r); setStep(null); }}>
                  {RANGE[r].label}
                </button>
              ))}
            </div>
          )}
          {view && view.steps.length > 1 && (
            <div role="group" aria-label="Step">
              {view.steps.map(s => (
                <button key={s} type="button" aria-pressed={s === view.step} onClick={() => setStep(s)} title={`One point per ${s}`}>
                  {STEP[s].label}
                </button>
              ))}
            </div>
          )}
          {view?.ohlc && (
            <div role="group" aria-label="Style">
              <button type="button" aria-pressed={!candles} onClick={() => setCandles(false)}>
                Line
              </button>
              <button type="button" aria-pressed={candles} onClick={() => setCandles(true)}>
                Candles
              </button>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
