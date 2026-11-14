"use client";

import {useCallback, useLayoutEffect, useRef, type ReactNode} from 'react';
import './segmented-navigation.css';

type Props = {
 as?: 'nav' | 'div';
 className?: string;
 label: string;
 value: string | number;
 variant?: 'underline' | 'pill';
 children: ReactNode;
};

export function positionSegmentIndicator(group: HTMLElement, marker: HTMLElement, variant: Props['variant'], animate: boolean) {
  const active = group.querySelector<HTMLElement>(':scope > button[aria-current="page"], :scope > button[aria-pressed="true"]');
  if (!active || !active.offsetWidth || !active.offsetHeight) {
   delete group.dataset.indicatorReady;
   delete marker.dataset.geometry;
   return;
  }
  // Local layout coordinates remain valid when the tab strip is scrolled or its
  // ancestors animate. Reading viewport rectangles would apply their transforms twice.
  const width = active.offsetWidth;
  const height = variant === 'underline' ? 2 : active.offsetHeight;
  const x = active.offsetLeft;
  const y = active.offsetTop + active.offsetHeight - height;
  const geometry = [x, y, width, height].join(',');
  if (geometry === marker.dataset.geometry) return;
  marker.dataset.moving = String(animate && !!marker.dataset.geometry);
  marker.style.transform = `translate(${x}px, ${y}px)`;
  marker.style.width = `${width}px`;
  marker.style.height = `${height}px`;
  group.dataset.indicatorReady = '';
  marker.dataset.geometry = geometry;
}

export function SegmentedNavigation({as = 'nav', className = '', label, value, variant = 'underline', children}: Props) {
 const container = useRef<HTMLElement | null>(null);
 const indicator = useRef<HTMLSpanElement>(null);
 const attachContainer = useCallback((node: HTMLElement | null) => { container.current = node; }, []);
 const positionIndicator = useCallback((animate: boolean) => {
  if (container.current && indicator.current) positionSegmentIndicator(container.current, indicator.current, variant, animate);
 }, [variant]);

 useLayoutEffect(() => { positionIndicator(true); }, [positionIndicator, value]);
 useLayoutEffect(() => {
  const group = container.current;
  if (!group) return;
  const resize = () => positionIndicator(false);
  if (typeof ResizeObserver === 'undefined') {
   window.addEventListener('resize', resize);
   return () => window.removeEventListener('resize', resize);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(group);
  for (const button of group.querySelectorAll(':scope > button')) observer.observe(button);
  return () => observer.disconnect();
 }, [positionIndicator]);

 const Tag = as;
 return <Tag ref={attachContainer} role={as === 'div' ? 'group' : undefined} aria-label={label}
  className={`segmented-navigation ${className}`} data-indicator-variant={variant}>
  <span ref={indicator} className="segment-indicator" aria-hidden="true"/>
  {children}
 </Tag>;
}
