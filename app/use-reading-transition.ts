"use client";
import { useLayoutEffect, useRef } from 'react';

/** Animate the reading heading after a selection; retain focus and chart state in place. */
export function useReadingTransition<T extends HTMLElement>(selection: string | number, skipAnchor = false) {
  const ref = useRef<T>(null);
  const previous = useRef(selection);
  useLayoutEffect(() => {
    if (previous.current === selection) return;
    previous.current = selection;
    const target = ref.current;
    if (!target || typeof target.animate !== 'function' || (skipAnchor && location.hash)) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) return;
    const animation = target.animate([
      { opacity: .78, transform: 'translateY(5px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
    const stop = () => animation.cancel();
    preference.addEventListener('change', stop);
    return () => {
      preference.removeEventListener('change', stop);
      stop();
    };
  }, [selection, skipAnchor]);
  return ref;
}
