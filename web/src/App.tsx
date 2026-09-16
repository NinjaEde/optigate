import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Server,
  ScrollText,
  RefreshCw,
  Plus,
  ShieldCheck,
  Search,
  X,
  Wrench,
  KeyRound,
  SlidersHorizontal,
  Users,
  LogOut,
} from 'lucide-react';

import { api, auth, tokenStorage, type MCPServer, type AuditEvent, type ToolMeta, type LocalUser } from './api';
import { ServerDialog } from './components/ServerDialog';
import { ServerCard } from './components/ServerCard';
import { ToolSearchView } from './components/ToolSearchView';
import { ApiKeysView } from './components/ApiKeysView';
import { SettingsView } from './components/SettingsView';
import { LoginView } from './components/LoginView';
import { UsersView } from './components/UsersView';
import { LanguageDropdown } from './components/LanguageDropdown';
import { LangContext, useLang, useT, type Lang } from './i18n';

type View = 'servers' | 'tools' | 'audit' | 'apikeys' | 'settings' | 'users';

export function App() {
  const [lang, setLang] = useState<Lang>(() => {
    const stored = localStorage.getItem('optigate.lang');
    return stored === 'en' || stored === 'fr' || stored === 'de' ? stored : 'de';
  });

  function switchLang(next: Lang) {
    setLang(next);
    localStorage.setItem('optigate.lang', next);
    document.documentElement.lang = next;
  }

  return (
    <LangContext.Provider value={lang}>
      <AppBody onSwitchLang={switchLang} />
    </LangContext.Provider>
  );
}

function AppBody({ onSwitchLang }: { onSwitchLang: (lang: Lang) => void }) {
  const t = useT();
  const lang = useLang();
  const dateTime = (iso: string) =>
    new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [toolsByServer, setToolsByServer] = useState<Record<string, ToolMeta[]>>({});
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('servers');
  const [identity, setIdentity] = useState<{
    role: string;
    tenantId: string | null;
  } | null>(null);
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [localUser, setLocalUser] = useState<LocalUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const reload = useCallback(async () => {
    try {
      setServers(await api.listServers());
      setAudit(await api.audit());
      setError(null);
    } catch (err) {
      // Expired local sessions land here: fall back to the login form.
      if (authMode === 'local' && !tokenStorage.get()) {
        setLocalUser(null);
        setIdentity(null);
      }
      setError((err as Error).message);
    }
  }, [authMode]);

  function applyIdentity(role: string, tenantId: string | null) {
    setIdentity({ role, tenantId });
  }

  function handleLoggedIn(user: LocalUser) {
    setLocalUser(user);
    applyIdentity(user.role, user.tenantId);
    setView('servers');
    void reload();
  }

  function handleLogout() {
    auth.logout();
    setLocalUser(null);
    setIdentity(null);
    setServers([]);
    setAudit([]);
    setView('servers');
  }

  useEffect(() => {
    // Auth mode decides the boot path: 'local' needs a Bearer session
    // (login form when absent), dev/keycloak keep the previous behavior.
    auth.mode().then(
      (m) => {
        setAuthMode(m.mode);
        if (m.mode === 'local') {
          auth.me().then(
            (me) => {
              applyIdentity(me.role, me.tenantId);
              setLocalUser({
                id: me.userId,
                username: me.username ?? me.userId,
                role: me.role as LocalUser['role'],
                tenantId: me.tenantId,
                isActive: true,
                createdAt: '',
                updatedAt: '',
              });
              void reload();
            },
            () => undefined,
          ).finally(() => setAuthChecked(true));
        } else {
          void reload();
          // Own identity for gating admin-only views; failure keeps the nav
          // visible (endpoints still enforce server-side).
          api.whoami().then(
            (me) => applyIdentity(me.role, me.tenantId),
            () => undefined,
          );
          setAuthChecked(true);
        }
      },
      () => {
        // /auth/mode unreachable (old server): legacy boot path.
        void reload();
        api.whoami().then(
          (me) => applyIdentity(me.role, me.tenantId),
          () => undefined,
        );
        setAuthChecked(true);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fail closed: key and settings management appear only for
  // confirmed admin identities (briefly hidden for everyone while loading).
  const mayManage = identity !== null && identity.role !== 'user';
  const showUsers = authMode === 'local' && mayManage;

  function handleValidated(id: string, tools: ToolMeta[]) {
    setToolsByServer((prev) => ({ ...prev, [id]: tools }));
  }

  const editingServer = servers.find((s) => s.id === editId) ?? null;
  const healthyCount = servers.filter((s) => s.status === 'healthy').length;

  // alphabetisch sortieren (Name), dann nach Suchbegriff filtern
  const visibleServers = useMemo(() => {
    const sorted = [...servers].sort((a, b) =>
      a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }),
    );
    const q = query.trim().toLowerCase();
    if (!q) {
      return sorted;
    }
    return sorted.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [servers, query]);

  // Local mode without a session: login form instead of the dashboard.
  // (After all hooks — Rules of Hooks.)
  if (authMode === 'local' && authChecked && !localUser) {
    return (
      <div className="min-h-screen bg-stage text-ink">
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, #1c2233 1px, transparent 0)',
            backgroundSize: '28px 28px',
          }}
        />
        <div className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="mb-6 flex justify-end">
            <LanguageDropdown lang={lang} onChange={onSwitchLang} />
          </div>
          <LoginView onLoggedIn={handleLoggedIn} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stage text-ink">
      {/* Signature: feines Punktraster als "Control-Room"-Bühne */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, #1c2233 1px, transparent 0)',
          backgroundSize: '28px 28px',
        }}
      />

      <div className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* ── Header ── */}
        <header className="mb-12">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl
                            border border-action/40 bg-action/15
                            shadow-[0_0_24px_rgba(99,102,241,0.25)]">
              <Server size={22} className="text-indigo-300" />
            </div>

            <div className="mr-auto">
              <h1 className="font-display text-2xl font-bold sm:text-[1.7rem]">
                <span className="text-indigo-300">{t.app.titleTop}</span>
                <span className="bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
                  {t.app.titleBottom}
                </span>
              </h1>
              <p className="mt-0.5 text-sm text-muted">{t.app.slogan}</p>
            </div>

            <nav
              aria-label={t.app.viewNav}
              className="flex items-center gap-1 rounded-lg border border-line p-1"
            >
              {(
                [
                  ['servers', t.app.views.servers, <Server key="i" size={15} />],
                  ['tools', t.app.views.tools, <Wrench key="i" size={15} />],
                  ...(mayManage
                    ? [['apikeys', t.app.views.apikeys, <KeyRound key="i" size={15} />] as const]
                    : []),
                  ...(mayManage
                    ? [['settings', t.app.views.settings, <SlidersHorizontal key="i" size={15} />] as const]
                    : []),
                  ...(showUsers
                    ? [['users', t.app.views.users, <Users key="i" size={15} />] as const]
                    : []),
                  ['audit', t.app.views.audit, <ScrollText key="i" size={15} />],
                ] as const
              ).map(([key, label, icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  aria-pressed={view === key}
                  className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm
                              font-medium transition ${
                                view === key
                                  ? 'bg-action/15 text-indigo-300'
                                  : 'text-muted hover:text-ink'
                              }`}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </nav>

            <LanguageDropdown lang={lang} onChange={onSwitchLang} />

            {authMode === 'local' && localUser && (
              <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                <span className="max-w-[140px] truncate font-mono text-xs text-muted" title={localUser.username}>
                  {localUser.username}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  aria-label={t.login.logout}
                  title={t.login.logout}
                  className="rounded-md p-1 text-muted transition hover:text-ink"
                >
                  <LogOut size={15} />
                </button>
              </div>
            )}
          </div>

          {/* Suchzeile: Suche links · Statistik · Aktionen rechts (nur Server-View) */}
          {view === 'servers' && (
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-5">
            <label className="relative order-first w-full sm:w-auto sm:min-w-[280px] sm:flex-1 sm:max-w-sm">
              <span className="sr-only">{t.search.srLabel}</span>
              <Search
                size={15}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.search.placeholder}
                className="w-full rounded-lg border border-line bg-panel/60 py-2.5 pl-9 pr-9
                           text-sm text-ink outline-none transition placeholder:text-faint
                           focus:border-action/60"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={t.search.reset}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1
                             text-faint transition hover:text-ink"
                >
                  <X size={14} />
                </button>
              )}
            </label>

            <dl data-testid="server-stats" className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
              <div className="flex items-baseline gap-2">
                <dt className="text-muted">{t.stats.servers}</dt>
                <dd className="font-display text-lg font-semibold tabular-nums">
                  {servers.length}
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="flex items-center gap-1.5 text-signal">
                  <ShieldCheck size={14} />
                  <span className="sr-only sm:not-sr-only">{t.stats.healthy}</span>
                </dt>
                <dd className="font-display text-lg font-semibold tabular-nums text-signal">
                  {healthyCount}
                </dd>
              </div>
            </dl>

            {/* Aktionen rechts */}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void reload()}
                aria-label={t.app.reload}
                className="rounded-lg border border-line p-2.5 text-muted
                           transition hover:border-faint hover:text-ink"
              >
                <RefreshCw size={16} />
              </button>

              <button
                type="button"
                onClick={() => setRegisterOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg
                           bg-action px-4 py-2.5 text-sm font-semibold text-white
                           shadow-[0_8px_20px_rgba(99,102,241,0.3)] transition hover:bg-indigo-500"
              >
                <Plus size={16} />
                {t.app.register}
              </button>
            </div>
          </div>
          )}
        </header>

        {error && (
          <p role="alert" className="mb-6 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {t.app.apiError}: {error}
          </p>
        )}

        {/* ── Content ── */}
        {view === 'tools' ? (
          <ToolSearchView />
        ) : view === 'apikeys' ? (
          <ApiKeysView
            tenantId={identity?.tenantId ?? null}
            tenantLocked={identity !== null && identity.role !== 'superadmin'}
          />
        ) : view === 'settings' ? (
          <SettingsView role={identity?.role ?? null} />
        ) : view === 'users' ? (
          <UsersView
            role={identity?.role ?? null}
            tenantId={identity?.tenantId ?? null}
          />
        ) : view === 'audit' ? (
          <div
            role="region"
            aria-label={t.app.views.audit}
            tabIndex={0}
            className="overflow-x-auto rounded-xl border border-line bg-panel/80"
          >
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3.5 font-medium">
                    {t.audit.time}
                  </th>
                  <th scope="col" className="px-5 py-3.5 font-medium">
                    {t.audit.action}
                  </th>
                  <th scope="col" className="px-5 py-3.5 font-medium">
                    {t.audit.actor}
                  </th>
                  <th scope="col" className="hidden px-5 py-3.5 font-medium md:table-cell">
                    {t.audit.detail}
                  </th>
                </tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.id} className="border-b border-line/50 last:border-0 transition hover:bg-white/[0.03]">
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-muted">
                      {dateTime(e.at)}
                    </td>
                    <td className="px-5 py-3">
                      <span className="rounded-md bg-action/10 px-2 py-0.5 font-mono text-xs text-indigo-300">
                        {e.action}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-muted">{e.actorId}</td>
                    <td className="hidden max-w-xs truncate px-5 py-3 text-faint md:table-cell">
                      {JSON.stringify(e.detail)}
                    </td>
                  </tr>
                ))}
                {audit.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-12 text-center text-faint">
                      {t.audit.empty}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            {visibleServers.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {visibleServers.map((s) => (
                  <ServerCard
                    key={s.id}
                    server={s}
                    tools={toolsByServer[s.id]}
                    onChanged={reload}
                    onEdit={(id) => setEditId(id)}
                    onValidated={handleValidated}
                  />
                ))}
              </div>
            ) : query.trim() ? (
              <div className="rounded-xl border border-dashed border-line p-16 text-center">
                <Search size={40} className="mx-auto mb-4 text-faint" />
                <p className="mb-1 font-display font-medium text-ink">
                  {t.search.noResultsTitle} „{query.trim()}“
                </p>
                <p className="text-sm text-muted">{t.search.noResultsHint}</p>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-line p-16 text-center">
                <Server size={40} className="mx-auto mb-4 text-faint" />
                <p className="mb-1 font-display font-medium text-ink">{t.empty.title}</p>
                <p className="text-sm text-muted">{t.empty.hint}</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Dialogs ── */}
      <ServerDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onSaved={() => void reload()}
      />
      <ServerDialog
        server={editingServer ?? undefined}
        open={editId !== null}
        onClose={() => setEditId(null)}
        onSaved={() => void reload()}
      />
    </div>
  );
}
