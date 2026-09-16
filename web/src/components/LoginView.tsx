import { useState, type FormEvent } from 'react';
import { KeyRound, Loader2, Server } from 'lucide-react';

import { auth, type LocalUser } from '../api';
import { useT } from '../i18n';

const inputClass =
  'w-full rounded-lg border border-line bg-stage px-3 py-2.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

export function LoginView({ onLoggedIn }: { onLoggedIn: (user: LocalUser) => void }) {
  const t = useT().login;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await auth.login(username.trim(), password);
      onLoggedIn(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-line bg-panel/80 p-8"
      >
        <div
          className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl
                     border border-action/40 bg-action/15"
        >
          <Server size={22} className="text-indigo-300" />
        </div>
        <h2 className="mb-1 text-center font-display text-xl font-bold">
          Opti<span className="bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">Gate</span>
        </h2>
        <p className="mb-6 text-center text-sm text-muted">{t.subtitle}</p>

        <label className="mb-4 block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
            {t.username}
          </span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            className={inputClass}
          />
        </label>

        <label className="mb-6 block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
            {t.password}
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className={inputClass}
          />
        </label>

        {error && (
          <p role="alert" className="mb-4 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg
                     bg-action px-4 py-2.5 text-sm font-semibold text-white
                     shadow-[0_8px_20px_rgba(99,102,241,0.3)] transition hover:bg-indigo-500
                     disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
          {busy ? t.submitting : t.submit}
        </button>
      </form>
    </div>
  );
}
