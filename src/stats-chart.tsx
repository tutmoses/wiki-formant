'use client';

// stats-chart.tsx — visitors per day for `Stats`, with a date axis and a count
// axis. `lightweight-charts` is loaded on mount, so the rest of the page paints
// without it. Every colour is the box's own `color`, like the bars beside it.

import { useEffect, useRef } from 'react';
import type { AutoscaleInfo, IChartApi } from 'lightweight-charts';

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

/** Counts start at zero, so a quiet week does not read as a collapse. */
const fromZero = (base: () => AutoscaleInfo | null) => {
  const info = base();
  if (info?.priceRange) info.priceRange.minValue = 0;
  return info;
};

/** One `[YYYY-MM-DD, visitors]` per UTC day, oldest first. */
export function StatsChart({ series }: { series: readonly (readonly [string, number])[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    let chart: IChartApi | undefined;
    let disposed = false;

    import('lightweight-charts').then(({ createChart, AreaSeries, ColorType, CrosshairMode, LineStyle }) => {
      if (disposed) return;
      const { color, fontFamily } = getComputedStyle(box);
      const ink = rgba(color);
      const guide = { color: rgba(color, 0.4), width: 1, style: LineStyle.Dotted } as const;
      chart = createChart(box, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: rgba(color, 0.7), fontFamily },
        grid: { vertLines: { visible: false }, horzLines: { color: rgba(color, 0.1) } },
        crosshair: { mode: CrosshairMode.Magnet, vertLine: guide, horzLine: guide },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
        handleScroll: false,
        handleScale: false,
      });
      chart
        .addSeries(AreaSeries, {
          lineColor: ink,
          topColor: rgba(color, 0.4),
          bottomColor: rgba(color, 0.02),
          lineWidth: 2,
          crosshairMarkerBackgroundColor: ink,
          priceLineVisible: false,
          priceFormat: { type: 'price', precision: 0, minMove: 1 },
          autoscaleInfoProvider: fromZero,
        })
        .setData(series.map(([time, value]) => ({ time, value })));
      chart.timeScale().fitContent();
    });

    return () => {
      disposed = true;
      chart?.remove();
    };
  }, [series]);

  return <div ref={ref} className="stats-chart" role="img" aria-label="Visitors per day" />;
}
