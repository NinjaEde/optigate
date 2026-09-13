import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  KeyRound,
  Plus,
  Copy,
  Check,
  X,
  Ban,
  Loader2,
} from 'lucide-react';

import { api, type ApiKey, type ApiKeyRole } from '../api';
import { useT } from '../i18n';

/** Display prefix: normalizes og_og_… rows stored before the prefix fix. */
function displayPrefix(key: ApiKey): string {
  return key.keyPrefix.replace(/^og_og_/, 'og_');
}

function keyStatus(key: ApiKey, now: number): 'active' | 'expired' | 'revoked' {
  if (key.revokedAt) {
    return 'revoked';
  }
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) {
    return 'expired';
  }
  return 'active';
}

const inputClass =
  'w-full rounded-lg border border-line bg-stage px-3 py-2.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
const labelClass =
  'text-xs font-medium uppercase tracking-wider text-muted';

export function ApiKeysView() {
  const t = useT().apikeys;
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const panelRef = useRef<HTMLFormElement>(null) as RefObject<HTMLFormElement>;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listApiKeys();
      setKeys(res.keys);
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

  // Esc schließt den Erstellen-Dialog
  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    panelRef.current
      ?.querySelector<HTMLElement>('input, select')
      ?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setDialogOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen]);

  async function revoke(id: string) {
    if (!window.confirm(t.revokeConfirm)) {
      return;
    }
    setBusyId(id);
    try {
      await api.revokeApiKey(id);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function copySecret() {
    if (!createdSecret) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdSecret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard-API unverfügbar (z. B. unsicherer Kontext) → manuell kopieren
      setCopied(false);
    }
  }

  const now = Date.now();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-2xl text-sm text-muted">{t.intro}</p>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-action px-4 py-2.5
                     text-sm font-semibold text-white shadow-[0_8px_20px_rgba(99,102,241,0.3)]
                     transition hover:bg-indigo-500"
        >
          <Plus size={16} />
          {t.create}
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
          {/admin/i.test(error) && (
            <span className="mt-1 block text-red-400/80">{t.forbiddenHint}</span>
          )}
        </p>
      )}

      {createdSecret && (
        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
          <p className="mb-1 font-medium text-amber-300">{t.showOnceTitle}</p>
          <p className="mb-3 text-sm text-amber-200/80">{t.showOnceHint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-amber-500/30 bg-stage px-3 py-2.5 font-mono text-sm text-ink">
              {createdSecret}
            </code>
            <button
              type="button"
              onClick={() => void copySecret()}
              className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40
                         px-3 py-2.5 text-sm font-medium text-amber-200 transition hover:bg-amber-500/10"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? t.copied : t.copy}
            </button>
            <button
              type="button"
              onClick={() => setCreatedSecret(null)}
              className="rounded-lg px-3 py-2.5 text-sm text-muted transition hover:text-ink"
            >
              {t.dismiss}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-panel/80">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wider text-muted">
            <tr>
              <th scope="col" className="px-5 py-3.5 font-medium">{t.name}</th>
              <th scope="col" className="px-5 py-3.5 font-medium">{t.prefix}</th>
              <th scope="col" className="px-5 py-3.5 font-medium">{t.role}</th>
              <th scope="col" className="px-5 py-3.5 font-medium">{t.tenant}</th>
              <th scope="col" className="px-5 py-3.5 font-medium">{t.created}</th>
              <th scope="col" className="px-5 py-3.5 font-medium"><span className="sr-only">{t.revoke}</span></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const status = keyStatus(k, now);
              return (
                <tr key={k.id} className="border-b border-line/50 last:border-0 transition hover:bg-white/[0.03]">
                  <td className="px-5 py-3 font-medium">
                    <span className="mr-2 inline-flex items-center gap-1.5">
                      <KeyRound size={14} className="text-faint" />
                      {k.name}
                    </span>
                    <span
                      className={`rounded-md px-2 py-0.5 font-mono text-xs ${
                        status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-300'
                          : status === 'expired'
                            ? 'bg-amber-500/10 text-amber-300'
                            : 'bg-red-500/10 text-red-400'
                      }`}
                    >
                      {status === 'active' ? t.active : status === 'expired' ? t.expired : t.revoked}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted">{displayPrefix(k)}…</td>
                  <td className="px-5 py-3 text-muted">{k.role}</td>
                  <td className="px-5 py-3 text-muted">{k.tenantId ?? '—'}</td>
                  <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-muted">
                    {new Date(k.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {status === 'active' && (
                      <button
                        type="button"
                        onClick={() => void revoke(k.id)}
                        disabled={busyId === k.id}
                        title={t.revoke}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5
                                   text-xs text-muted transition hover:border-red-500/40 hover:text-red-400
                                   disabled:opacity-50"
                      >
                        {busyId === k.id ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
                        {t.revoke}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && keys.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-faint">
                  {t.empty}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-faint">
                  <Loader2 size={18} className="mx-auto animate-spin" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {dialogOpen && (
        <CreateDialog
          panelRef={panelRef}
          onClose={() => setDialogOpen(false)}
          onCreated={(secret) => {
            setDialogOpen(false);
            setCreatedSecret(secret);
            void reload();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function CreateDialog({
  panelRef,
  onClose,
  onCreated,
  onError,
}: {
  panelRef: RefObject<HTMLFormElement>;
  onClose: () => void;
  onCreated: (secret: string) => void;
  onError: (msg: string) => void;
}) {
  const t = useT().apikeys;
  const [name, setName] = useState('');
  const [role, setRole] = useState<ApiKeyRole>('user');
  const [tenant, setTenant] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await api.createApiKey({
        name: name.trim(),
        role,
        ...(tenant.trim() ? { tenantId: tenant.trim() } : {}),
        ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
      });
      onCreated(res.secret);
    } catch (err) {
      onError((err as Error).message);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-stage/80
                 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        onSubmit={(e) => void submit(e)}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.dialogTitle}
        className="max-h-[92vh] w-full max-w-lg space-y-5 overflow-y-auto rounded-t-2xl
                   border border-line bg-panel p-6 shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t.dialogTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted transition hover:bg-white/[0.06] hover:text-ink"
            aria-label={t.cancel}
          >
            <X size={18} />
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className={labelClass}>{t.name}</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.namePlaceholder}
            maxLength={100}
            className={inputClass}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className={labelClass}>{t.role}</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as ApiKeyRole)}
              className={inputClass}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
              <option value="superadmin">superadmin</option>
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className={labelClass}>{t.tenant}</span>
            <input
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder={t.tenantPlaceholder}
              className={inputClass}
            />
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className={labelClass}>{t.expires}</span>
          <input
            type="datetime-local"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
            className={`${inputClass} [color-scheme:dark]`}
          />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2.5 text-sm text-muted
                       transition hover:border-faint hover:text-ink"
          >
            {t.cancel}
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-action px-4 py-2.5
                       text-sm font-semibold text-white transition hover:bg-indigo-500
                       disabled:opacity-50"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {t.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
