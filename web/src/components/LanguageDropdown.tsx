import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe } from 'lucide-react';

import { LANGUAGES, useT, type Lang } from '../i18n';

interface Props {
  lang: Lang;
  onChange: (lang: Lang) => void;
}

/**
 * Custom-styled language dropdown (DE/EN/FR). Closes on outside click
 * and Escape; ArrowUp/Down/Home/End move between options, Enter selects.
 */
export function LanguageDropdown({ lang, onChange }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  function focusOption(index: number) {
    const count = LANGUAGES.length;
    const next = ((index % count) + count) % count;
    optionRefs.current[next]?.focus();
  }

  function select(code: Lang) {
    onChange(code);
    setOpen(false);
    triggerRef.current?.focus();
  }

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
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  // focus the current option when the menu opens
  useEffect(() => {
    if (open) {
      focusOption(Math.max(0, LANGUAGES.findIndex((l) => l.code === lang)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'Enter') && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t.lang.label}
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
          aria-label={t.lang.label}
          className="absolute right-0 z-20 mt-2 w-36 overflow-hidden rounded-xl border
                     border-line bg-panel py-1 shadow-2xl shadow-black/40"
        >
          {LANGUAGES.map(({ code, label }, index) => (
            <li key={code}>
              <button
                ref={(el) => {
                  optionRefs.current[index] = el;
                }}
                type="button"
                role="option"
                aria-selected={lang === code}
                onClick={() => select(code)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    focusOption(index + 1);
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    focusOption(index - 1);
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    focusOption(0);
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    focusOption(LANGUAGES.length - 1);
                  }
                }}
                className={`flex w-full items-center justify-between px-4 py-2.5 text-sm
                            transition hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none ${
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
