import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SiteIcon } from '../src/ui/site-icon';

const catalog = JSON.parse(
  readFileSync(new FileURL('../../components/xray-core/common/siteusage/catalog.json', import.meta.url), 'utf8'),
) as { sites: { id: string }[] };
const generic = new Set(['other', 'sniffing-failed', 'unidentified']);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('bundles a local, decorative brand outline for every known site', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const brands = catalog.sites.filter(site => !generic.has(site.id));
  const view = render(
    <>
      {brands.map(site => (
        <SiteIcon key={site.id} siteId={site.id} />
      ))}
    </>,
  );
  for (const { id } of brands) {
    const icon = view.container.querySelector(`[data-site-icon="${id}"]`);
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector(':scope > svg > path')?.getAttribute('d')?.length).toBeGreaterThan(0);
    expect(icon?.querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
    expect(icon?.querySelector('svg')?.getAttribute('focusable')).toBe('false');
  }
  expect(view.container.querySelectorAll('img, image, use, script')).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it('uses local generic icons for unclassified traffic and unknown categories', () => {
  for (const id of [...generic, 'future-category', 'constructor', '__proto__']) {
    const view = render(<SiteIcon siteId={id} />);
    expect(view.container.querySelector('.site-brand-icon .ui-icon svg')).not.toBeNull();
    view.unmount();
  }
});
