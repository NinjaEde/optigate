import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe } from 'lucide-react';

import { LANGUAGES, type Lang } from '../i18n';

interface Props {
  lang: Lang;
  onChange: (lang: Lang) => void;
}

/**
 * Custom-styled language dropdown (DE/EN/FR). Closes on outside click
 * and Escape; fully keyboard accessible.
 */
export function LanguageDropdown({ lang, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Language"
        className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm
                    font-medium transition ${
                      open
                        ? 'border-action/60 bg-action/10 text-indigo-300'
                        : 'border-line text-muted hover:border-faint hover:text-ink'
                    }`}
      >
        <Globe size={15} aria-hidden="true" />
        {current.label}
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Language"
          className="absolute right-0 z-20 mt-2 w-36 overflow-hidden rounded-xl border
                     border-line bg-panel py-1 shadow-2xl shadow-black/40"
        >
          {LANGUAGES.map(({ code, label }) => (
            <li key={code}>
              <button
                type="button"
                role="option"
                aria-selected={lang === code}
                onClick={() => {
                  onChange(code);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between px-4 py-2.5 text-sm
                            transition hover:bg-white/[0.06] ${
                              lang === code ? 'text-indigo-300' : 'text-muted'
                            }`}
              >
                <span>{label}</span>
                {lang === code && <Check size={14} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
