'use client';

// next.tsx — the parts of `wiki-formant/react` bound to Next's router, so a
// layout passes a rail its data and nothing else. Every site had written the
// same wrapper to hand `Rail` its `next/link` and `usePathname()`; a Server
// Component cannot pass either, so each wrapper was a client module of its own.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  HeaderNav as RouterlessHeaderNav,
  Rail as RouterlessRail,
  type HeaderNavProps as RouterlessHeaderNavProps,
  type RailProps as RouterlessRailProps,
} from './react.js';

export interface RailProps extends Omit<RouterlessRailProps, 'pathname' | 'link'> {
  /** The address being read, where it is not the router's. */
  pathname?: string;
}

/**
 * `Rail` on Next's router. The pathname is the router's, with `/index` read as
 * `/`: a catch-all that serves the home page renders under `/index` in
 * production, and the rail's Home would otherwise go unlit there.
 */
export function Rail({ pathname, ...props }: RailProps) {
  return <RouterlessRail {...props} pathname={useRoutedPath(pathname)} link={Link} />;
}

export interface HeaderNavProps extends Omit<RouterlessHeaderNavProps, 'pathname' | 'link'> {
  /** The address being read, where it is not the router's. */
  pathname?: string;
}

/** `HeaderNav` on Next's router, its pathname read as the rail's is. */
export function HeaderNav({ pathname, ...props }: HeaderNavProps) {
  return <RouterlessHeaderNav {...props} pathname={useRoutedPath(pathname)} link={Link} />;
}

function useRoutedPath(pathname: string | undefined): string {
  const routed = usePathname();
  return pathname ?? (routed === '/index' ? '/' : routed);
}
