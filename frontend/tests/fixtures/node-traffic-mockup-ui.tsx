// Shared bits for the machine traffic tab mockup (node-traffic-mockup.html). Never imported by the app.
import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { bytes } from '../../src/ui/format';
import { observeBpsReadingParts } from '../../src/ui/observe-chart';
import { RegionFlag } from '../../src/ui/region-flag';
import type { ChainView } from './node-traffic-mockup-data';

export const amount = (value: number) => {
  const [figure, unit] = bytes(value).split(' ');
  return (
    <>
      {figure}
      <small>{unit}</small>
    </>
  );
};

/** 速率读数：协议给字节/秒，界面写 bit/s（同实时卡与机队卡）。 */
export function Rate({ value, reference }: { value: number; reference?: number }) {
  const parts = observeBpsReadingParts(value * 8, reference === undefined ? undefined : reference * 8);
  return (
    <>
      {value > 0 ? parts.number : '0'}
      <small>{parts.unit}</small>
    </>
  );
}

export function ChainName({ view, flag = true }: { view: ChainView; flag?: boolean }) {
  return (
    <span className={`nt-chain${view.kind === 'chain' ? '' : ' muted'}`}>
      {flag && view.country && <RegionFlag code={view.country} />}
      <span className="nt-chain-name">{view.name}</span>
    </span>
  );
}

export const Swatch = ({ view }: { view: ChainView }) => (
  <i
    className={`nt-swatch${view.kind === 'chain' ? '' : ` ${view.kind}`}`}
    style={{ background: view.color }}
    aria-hidden="true"
  />
);

export function useWidth<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export interface Tip {
  left: number;
  top: number;
  above: boolean;
  body: ReactNode;
}
/** 提示框贴在目标下方；above 时翻到目标上方（卡片底部的图）。 */
export function useTip(card: RefObject<HTMLElement | null>) {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (element: Element, body: ReactNode, above = false) => {
    const box = element.getBoundingClientRect();
    const frame = card.current!.getBoundingClientRect();
    setTip({
      left: Math.max(8, Math.min(box.left - frame.left, frame.width - 248)),
      top: above ? box.top - frame.top - 8 : box.bottom - frame.top + 6,
      above,
      body,
    });
  };
  const hide = () => setTip(null);
  const layer = tip && (
    <div
      role="tooltip"
      className={`uxm-tip nt-tip${tip.above ? ' above' : ''}`}
      style={{ left: tip.left, top: tip.top }}
    >
      {tip.body}
    </div>
  );
  return { show, hide, layer };
}
