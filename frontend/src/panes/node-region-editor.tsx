import { useLayoutEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ErrorBox } from '../ui/bits';
import { DialogClose, DialogLayer } from '../ui/dialog';
import { Icon } from '../ui/icons';
import { RegionFlag } from '../ui/region-flag';
import { CUSTOM_REGION_CODE, REGION_GROUPS } from '../ui/region-groups';

const REGION_NAMES = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });

function regionLabel(code: string): string {
  if (code === CUSTOM_REGION_CODE) return `${code} · 自定义旗帜位`;
  const name = REGION_NAMES.of(code);
  return name && name !== code ? `${code} · ${name}` : code;
}

function RegionMark({
  countryCode,
  lampTone,
  lampWhy,
  editable,
}: {
  countryCode: string | null | undefined;
  lampTone: string;
  lampWhy: string;
  editable: boolean;
}) {
  if (!countryCode && !editable) {
    return (
      <span className="nd-status-slot">
        <i className={`node-lamp ${lampTone}`} title={lampWhy} aria-label={lampWhy} />
      </span>
    );
  }
  return (
    <span className={`nd-idplate${countryCode ? '' : ' empty'}`}>
      <span className="nd-idplate-clip">
        {countryCode ? <RegionFlag code={countryCode} square /> : <Icon of="region" size={15} />}
      </span>
      <i
        className={`node-lamp ${lampTone}`}
        title={lampWhy}
        aria-label={editable ? undefined : lampWhy}
        aria-hidden={editable || undefined}
      />
    </span>
  );
}

export function NodeRegionEditor({
  nodeName,
  countryCode,
  detectedCountryCode,
  overrideCountryCode,
  lampTone,
  lampWhy,
  editable,
  onSave,
  onSaved,
}: {
  nodeName: string;
  countryCode: string | null | undefined;
  detectedCountryCode: string | null | undefined;
  overrideCountryCode: string | null | undefined;
  lampTone: string;
  lampWhy: string;
  editable: boolean;
  onSave: (countryCode: string | null) => Promise<unknown>;
  onSaved?: () => void;
}) {
  const normalizedOverride = overrideCountryCode?.trim().toUpperCase() || '';
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(normalizedOverride);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (open) initialFocusRef.current?.focus();
  }, [open]);
  const save = useMutation({
    mutationFn: () => onSave(selected || null),
    onSuccess: () => {
      onSaved?.();
      setOpen(false);
    },
  });
  const currentLabel = countryCode ? regionLabel(countryCode) : '未识别地区';

  const mark = <RegionMark countryCode={countryCode} lampTone={lampTone} lampWhy={lampWhy} editable={editable} />;
  if (!editable) return mark;

  return (
    <>
      <button
        className="nd-region-trigger"
        type="button"
        aria-label={`更换 ${nodeName} 的地区，当前 ${currentLabel}；${lampWhy}`}
        title="更换地区"
        onClick={() => {
          save.reset();
          setSelected(normalizedOverride);
          setOpen(true);
        }}
      >
        {mark}
      </button>
      {open && (
        <DialogLayer label={`更换 ${nodeName} 的地区`} onClose={() => setOpen(false)} canClose={() => !save.isPending}>
          <form
            className="dialog-surface confirm-card node-region-dialog"
            onSubmit={event => {
              event.preventDefault();
              if (selected !== normalizedOverride) save.mutate();
            }}
          >
            <div className="confirm-title">更换机器地区</div>
            <div className="confirm-body">
              <p>
                IP 库判断：{detectedCountryCode ? regionLabel(detectedCountryCode) : '暂无结果'}。手动选择只修正 Console
                中的地区标识，不会触发配置发布。
              </p>
              <div className="node-region-choices" role="group" aria-label="机器地区">
                <button
                  className={`node-region-auto${selected ? '' : ' selected'}`}
                  type="button"
                  ref={!normalizedOverride ? initialFocusRef : undefined}
                  aria-pressed={!selected}
                  disabled={save.isPending}
                  onClick={() => setSelected('')}
                >
                  <Icon of="region" size={14} />
                  <span>
                    自动判断
                    {detectedCountryCode && <small>{regionLabel(detectedCountryCode)}</small>}
                  </span>
                </button>
                <div className="node-region-sections">
                  {REGION_GROUPS.map(group => (
                    <section className="node-region-section" key={group.id} aria-labelledby={`node-region-${group.id}`}>
                      <div className="node-region-section-head" id={`node-region-${group.id}`}>
                        <span>{group.label}</span>
                        <small>{group.codes.length}</small>
                        {group.id === 'special' && <em>XX 为预留自定义位</em>}
                      </div>
                      <div className="node-region-grid" role="group" aria-label={`${group.label}地区`}>
                        {group.codes.map(code => (
                          <button
                            key={code}
                            className={selected === code ? 'selected' : undefined}
                            type="button"
                            ref={normalizedOverride === code ? initialFocusRef : undefined}
                            aria-label={`选择 ${regionLabel(code)}`}
                            aria-pressed={selected === code}
                            title={regionLabel(code)}
                            disabled={save.isPending}
                            onClick={() => setSelected(code)}
                          >
                            <RegionFlag code={code} />
                            <span>{code === CUSTOM_REGION_CODE ? '自定义' : code}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
              <div className="node-region-preview" aria-live="polite">
                {selected || detectedCountryCode ? <RegionFlag code={selected || detectedCountryCode} /> : null}
                <span>
                  {selected
                    ? `将固定为 ${regionLabel(selected)}`
                    : detectedCountryCode
                      ? `将恢复自动判断：${regionLabel(detectedCountryCode)}`
                      : '将恢复自动判断'}
                </span>
              </div>
              {save.error && <ErrorBox error={save.error} />}
            </div>
            <div className="confirm-actions">
              <DialogClose className="btn" disabled={save.isPending}>
                取消
              </DialogClose>
              <button
                className="btn primary"
                type="submit"
                disabled={selected === normalizedOverride || save.isPending}
              >
                {save.isPending ? '保存中…' : selected ? '保存地区' : '恢复自动判断'}
              </button>
            </div>
          </form>
        </DialogLayer>
      )}
    </>
  );
}
