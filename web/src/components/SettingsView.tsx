import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, RotateCcw, Save } from 'lucide-react';

import { api, type Setting } from '../api';
import { useT } from '../i18n';

const inputClass =
  'w-full rounded-lg border border-line bg-stage px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60';

const sourceStyles: Record<Setting['source'], string> = {
  db: 'bg-indigo-500/10 text-indigo-300',
  env: 'bg-amber-500/10 text-amber-300',
  default: 'bg-white/[0.04] text-faint',
};

export function SettingsView({ role }: { role: string | null }) {
  const t = useT();
  const st = t.settings;
  const [settings, setSettings] = useState<Setting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string | number | boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const canEdit = useCallback(
    (s: Setting) =>
      role === 'superadmin' || (role === 'admin' && s.minRole === 'admin'),
    [role],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listSettings();
      setSettings(res.settings);
      setDrafts(Object.fromEntries(res.settings.map((s) => [s.key, s.value])));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const keyMeta = st.keys as Record<string, { label: string; hint: string } | undefined>;

  function labelFor(s: Setting): string {
    return keyMeta[s.key]?.label ?? s.key;
  }

  function hintFor(s: Setting): string {
    return keyMeta[s.key]?.hint ?? s.description;
  }

  async function save(key: string) {
    setBusyKey(key);
    setError(null);
    try {
      const updated = await api.updateSetting(key, drafts[key]);
      setSettings((prev) => prev.map((s) => (s.key === key ? updated : s)));
      setDrafts((prev) => ({ ...prev, [key]: updated.value }));
      setSavedKey(key);
      window.setTimeout(() => {
        setSavedKey((cur) => (cur === key ? null : cur));
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function reset(key: string) {
    setBusyKey(key);
    setError(null);
    try {
      const updated = await api.resetSetting(key);
      setSettings((prev) => prev.map((s) => (s.key === key ? updated : s)));
      setDrafts((prev) => ({ ...prev, [key]: updated.value }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-muted">{st.intro}</p>

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
          {/admin|superadmin/i.test(error) && (
            <span className="mt-1 block text-red-400/80">{st.forbiddenHint}</span>
          )}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-panel/80">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wider text-muted">
            <tr>
              <th scope="col" className="px-5 py-3.5 font-medium">{st.colSetting}</th>
              <th scope="col" className="px-5 py-3.5 font-medium">{st.colValue}</th>
              <th scope="col" className="px-5 py-3.5 font-medium">{st.colSource}</th>
              <th scope="col" className="px-5 py-3.5 font-medium"><span className="sr-only">{st.save}</span></th>
            </tr>
          </thead>
          <tbody>
            {settings.map((s) => {
              const editable = canEdit(s);
              const draft = drafts[s.key] ?? s.value;
              return (
                <tr key={s.key} className="border-b border-line/50 align-top last:border-0 transition hover:bg-white/[0.03]">
                  <td className="max-w-xs px-5 py-4">
                    <p className="font-medium">{labelFor(s)}</p>
                    <p className="mt-0.5 font-mono text-xs text-faint">{s.key}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{hintFor(s)}</p>
                    {s.minRole === 'superadmin' && (
                      <p className="mt-1 text-xs text-amber-300/80">{st.superadminOnly}</p>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {s.type === 'boolean' ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={draft === true}
                        aria-label={labelFor(s)}
                        disabled={!editable}
                        onClick={() =>
                          setDrafts((prev) => ({ ...prev, [s.key]: !(prev[s.key] ?? s.value) }))
                        }
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition disabled:opacity-60 ${
                          draft === true ? 'bg-action' : 'bg-white/10'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                            draft === true ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    ) : (
                      <input
                        type={s.type === 'number' ? 'number' : 'text'}
                        value={String(draft)}
                        min={s.min}
                        max={s.max}
                        disabled={!editable}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [s.key]:
                              s.type === 'number' ? Number(e.target.value) : e.target.value,
                          }))
                        }
                        className={`${inputClass} max-w-xs font-mono`}
                      />
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-4">
                    <span className={`rounded-md px-2 py-0.5 font-mono text-xs ${sourceStyles[s.source]}`}>
                      {s.source === 'db' ? st.sourceDb : s.source === 'env' ? st.sourceEnv : st.sourceDefault}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-5 py-4 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      {savedKey === s.key && (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                          <Check size={13} />
                          {st.saved}
                        </span>
                      )}
                      {s.source === 'db' && editable && (
                        <button
                          type="button"
                          onClick={() => void reset(s.key)}
                          disabled={busyKey === s.key}
                          title={st.reset}
                          className="rounded-lg border border-line p-2 text-muted transition
                                     hover:border-faint hover:text-ink disabled:opacity-50"
                        >
                          {busyKey === s.key ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <RotateCcw size={14} />
                          )}
                        </button>
                      )}
                      {editable && (
                        <button
                          type="button"
                          onClick={() => void save(s.key)}
                          disabled={busyKey === s.key}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-2
                                     text-xs font-semibold text-white transition hover:bg-indigo-500
                                     disabled:opacity-50"
                        >
                          {busyKey === s.key ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Save size={14} />
                          )}
                          {st.save}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && settings.length === 0 && !error && (
              <tr>
                <td colSpan={4} className="px-5 py-12 text-center text-faint">
                  {st.empty}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={4} className="px-5 py-12 text-center text-faint">
                  <Loader2 size={18} className="mx-auto animate-spin" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
