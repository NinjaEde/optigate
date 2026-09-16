import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Ban, Loader2, Plus, RotateCcw, Users, X } from 'lucide-react';

import { auth, type ApiKeyRole, type LocalUser } from '../api';
import { useLang, useT } from '../i18n';

const inputClass =
  'w-full rounded-lg border border-line bg-stage px-3 py-2.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
const labelClass =
  'text-xs font-medium uppercase tracking-wider text-muted';

export function UsersView({
  role,
  tenantId = null,
}: {
  role: string | null;
  tenantId?: string | null;
}) {
  const t = useT().users;
  const lang = useLang();
  const dateTime = (iso: string) =>
    new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  const [usersList, setUsersList] = useState<LocalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newRole, setNewRole] = useState<ApiKeyRole>('user');
  const [tenant, setTenant] = useState('');

  const tenantLocked = role !== null && role !== 'superadmin';

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await auth.listUsers();
      setUsersList(res.users);
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

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusyId('create');
    try {
      await auth.createUser({
        username: username.trim(),
        password,
        role: newRole,
        ...(tenantLocked ? { tenantId: tenantId ?? '' } : tenant.trim() ? { tenantId: tenant.trim() } : {}),
      });
      setUsername('');
      setPassword('');
      setTenant('');
      setDialogOpen(false);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(user: LocalUser) {
    if (user.isActive && !window.confirm(t.deactivateConfirm)) {
      return;
    }
    setBusyId(user.id);
    try {
      await auth.updateUser(user.id, { isActive: !user.isActive });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (error && usersList.length === 0 && !loading) {
    return (
      <div className="rounded-xl border border-line bg-panel/80 p-8 text-center">
        <Users size={32} className="mx-auto mb-3 text-faint" />
        <p className="text-sm text-muted">{t.forbiddenHint}</p>
        <p className="mt-1 font-mono text-xs text-faint">{error}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-sm text-muted">{t.intro}</p>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="mb-4">
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-action px-4 py-2.5
                     text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          <Plus size={16} />
          {t.create}
        </button>
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-faint">{t.loading}</p>
      ) : usersList.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-12 text-center">
          <Users size={32} className="mx-auto mb-3 text-faint" />
          <p className="text-sm text-muted">{t.empty}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel/80">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="px-5 py-3.5 font-medium">{t.username}</th>
                <th scope="col" className="px-5 py-3.5 font-medium">{t.role}</th>
                <th scope="col" className="px-5 py-3.5 font-medium">{t.tenant}</th>
                <th scope="col" className="px-5 py-3.5 font-medium">{t.created}</th>
                <th scope="col" className="px-5 py-3.5 font-medium"><span className="sr-only">Aktionen</span></th>
              </tr>
            </thead>
            <tbody>
              {usersList.map((u) => (
                <tr key={u.id} className="border-b border-line/50 last:border-0 transition hover:bg-white/[0.03]">
                  <td className="px-5 py-3 font-mono text-xs">
                    {u.username}
                    <span className={`ml-2 rounded-md px-2 py-0.5 text-xs ${u.isActive ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-400'}`}>
                      {u.isActive ? t.active : t.inactive}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-muted">{u.role}</td>
                  <td className="px-5 py-3 font-mono text-xs text-muted">{u.tenantId ?? '—'}</td>
                  <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-muted">
                    {dateTime(u.createdAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => void toggleActive(u)}
                      disabled={busyId === u.id}
                      title={u.isActive ? t.deactivate : t.reactivate}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5
                                 text-xs text-muted transition hover:border-faint hover:text-ink
                                 disabled:opacity-50"
                    >
                      {busyId === u.id
                        ? <Loader2 size={13} className="animate-spin" />
                        : u.isActive ? <Ban size={13} /> : <RotateCcw size={13} />}
                      {u.isActive ? t.deactivate : t.reactivate}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={t.dialogTitle}>
          <form onSubmit={create} className="w-full max-w-md rounded-xl border border-line bg-panel p-6">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="font-display text-lg font-semibold">{t.dialogTitle}</h3>
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                aria-label={t.cancel}
                className="rounded-md p-1 text-faint transition hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>

            <label className="mb-4 block">
              <span className={`${labelClass} mb-1.5 block`}>{t.username}</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t.usernamePlaceholder}
                required
                minLength={3}
                className={inputClass}
              />
            </label>

            <label className="mb-4 block">
              <span className={`${labelClass} mb-1.5 block`}>{t.password}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={10}
                autoComplete="new-password"
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-faint">{t.passwordHint}</span>
            </label>

            <div className="mb-4 grid grid-cols-2 gap-3">
              <label className="block">
                <span className={`${labelClass} mb-1.5 block`}>{t.role}</span>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as ApiKeyRole)} className={inputClass}>
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                  {role === 'superadmin' && <option value="superadmin">superadmin</option>}
                </select>
              </label>
              <label className="block">
                <span className={`${labelClass} mb-1.5 block`}>{t.tenant}</span>
                <input
                  type="text"
                  value={tenantLocked ? (tenantId ?? '') : tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  disabled={tenantLocked}
                  placeholder={t.tenantPlaceholder}
                  className={`${inputClass} disabled:opacity-50`}
                />
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
              >
                {t.cancel}
              </button>
              <button
                type="submit"
                disabled={busyId === 'create'}
                className="inline-flex items-center gap-2 rounded-lg bg-action px-4 py-2
                           text-sm font-semibold text-white transition hover:bg-indigo-500
                           disabled:opacity-50"
              >
                {busyId === 'create' && <Loader2 size={14} className="animate-spin" />}
                {t.submit}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
