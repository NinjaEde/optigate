import { useEffect, useRef, useState } from 'react';
import { Plus, Loader2, KeyRound, X } from 'lucide-react';

import {
  api,
  type MCPServer,
  type Scope,
  type Transport,
  type AuthConfig,
} from '../api';
import { useT } from '../i18n';

/** Form-level auth config — plaintext fields are transport-only, never stored. */
interface FormAuthConfig {
  type: AuthConfig['type'];
  secretRef?: string;
  secretPlaintext?: string;
  headerName?: string;
  headerPrefix?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecretRef?: string;
  clientSecretPlaintext?: string;
  scopes?: string[];
}

interface Props {
  /** existing server → edit mode */
  server?: MCPServer;
  open?: boolean;
  onClose?: () => void;
  onSaved: (server: MCPServer) => void;
}

type AuthType = NonNullable<AuthConfig['type']>;
type SecretMode = 'ref' | 'direct';

const emptyForm = {
  name: '',
  description: '',
  scope: 'tenant' as Scope,
  transport: 'streamable_http' as Transport,
  url: '',
  command: '',
  args: '',
  authType: 'none' as AuthType,
  secretMode: 'ref' as SecretMode,
  secretRef: '',
  secretPlaintext: '',
  headerName: 'x-api-key',
  tokenUrl: '',
  clientId: '',
  clientSecretRef: '',
  clientSecretPlaintext: '',
};

/** Editor rows for connection.customHeaders (key/value, 0..n). */
type HeaderRow = { key: string; value: string };

function rowsFromHeaders(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
}

function headersFromRows(rows: HeaderRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((r) => ({ key: r.key.trim(), value: r.value }))
    .filter((r) => r.key !== '');
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries.map((r) => [r.key, r.value]));
}

/**
 * Splits an argument string into tokens, honoring double/single quotes:
 * `server.js --name "my server"` → ["server.js", "--name", "my server"]
 */
function tokenizeArgs(input: string): string[] {
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')/g) ?? [];
  return tokens.map((t) => t.replace(/^["']|["']$/g, ''));
}

export function ServerDialog({
  server,
  open,
  onClose,
  onSaved,
}: Props) {
  const t = useT();
  const editing = Boolean(server);
  const [visible, setVisible] = useState(open ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const panelRef = useRef<HTMLFormElement>(null);

  // Dialog-Verhalten: Fokus aufs erste Feld, Esc schließt
  useEffect(() => {
    if (!visible) {
      return;
    }
    panelRef.current
      ?.querySelector<HTMLElement>('input, textarea, select')
      ?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        close();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible]);

  useEffect(() => {
    if (typeof open === 'boolean') {
      setVisible(open);
    }
  }, [open]);

  useEffect(() => {
    if (visible && server) {
      setForm({
        ...emptyForm,
        name: server.name,
        description: server.description,
        transport: server.transport,
        url: server.connection.url ?? '',
        command: server.connection.command ?? '',
        args: (server.connection.args ?? []).join(' '),
        authType: server.connection.auth?.type ?? 'none',
        // existing stored secrets show as "configured" — keep mode on ref display
        secretMode:
          server.connection.auth?.secretRef === '__stored__'
            ? 'direct'
            : 'ref',
        secretRef:
          server.connection.auth?.secretRef === '__stored__'
            ? ''
            : server.connection.auth?.secretRef ?? '',
        headerName: server.connection.auth?.headerName ?? 'x-api-key',
        tokenUrl: server.connection.auth?.tokenUrl ?? '',
        clientId: server.connection.auth?.clientId ?? '',
      });
      setHeaderRows(rowsFromHeaders(server.connection.customHeaders));
    }
    if (!visible) {
      setForm(emptyForm);
      setHeaderRows([]);
      setError(null);
    }
  }, [visible, server]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function close() {
    setVisible(false);
    onClose?.();
  }

  function buildFormAuth(): FormAuthConfig | undefined {
    if (form.authType === 'none') {
      return { type: 'none' };
    }

    const auth: FormAuthConfig = { type: form.authType };

    if (form.secretMode === 'direct' && form.secretPlaintext) {
      auth.secretPlaintext = form.secretPlaintext;
    } else if (form.secretRef) {
      auth.secretRef = form.secretRef;
    }

    if (form.authType === 'api_key') {
      auth.headerName = form.headerName;
    }

    if (isOAuth) {
      auth.tokenUrl = form.tokenUrl;
      auth.clientId = form.clientId;
      if (form.clientSecretPlaintext) {
        auth.clientSecretPlaintext = form.clientSecretPlaintext;
      } else if (form.clientSecretRef) {
        auth.clientSecretRef = form.clientSecretRef;
      }
    }

    return auth;
  }

  function buildConnection() {
    const base =
      form.transport === 'stdio'
        ? { command: form.command.trim(), args: tokenizeArgs(form.args) }
        : { url: form.url };

    const auth = buildFormAuth();
    const customHeaders = headersFromRows(headerRows);

    return {
      ...base,
      auth,
      ...(customHeaders ? { customHeaders } : {}),
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (editing && server) {
        const updated = await api.updateServer(server.id, {
          name: form.name,
          description: form.description,
          transport: form.transport,
          connection: buildConnection(),
        });
        close();
        onSaved(updated);
      } else {
        const created = await api.registerServer({
          name: form.name,
          description: form.description,
          scope: form.scope,
          transport: form.transport,
          connection: buildConnection(),
        });
        close();
        onSaved(created);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const needsSecret = ['bearer', 'api_key', 'oauth2'].includes(form.authType);
  const isOAuth = form.authType === 'oauth2';

  return (
    <>
      {/* trigger button only when not externally controlled */}
      {typeof open !== 'boolean' && (
        <button
          onClick={() => setVisible(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4
                     py-2 text-sm font-semibold text-white shadow-sm
                     shadow-indigo-600/30 transition hover:bg-indigo-500"
        >
          <Plus size={16} />
          {t.dialog.registerTitle}
        </button>
      )}

      {visible && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-stage/80
                        p-0 backdrop-blur-sm sm:items-center sm:p-4"
             onClick={(e) => {
               if (e.target === e.currentTarget) {
                 close();
               }
             }}>
          <form
            onSubmit={submit}
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={editing ? t.dialog.editTitle : t.dialog.registerTitle}
            className="max-h-[92vh] w-full max-w-lg space-y-5 overflow-y-auto rounded-t-2xl
                       border border-line bg-panel p-6 shadow-2xl sm:rounded-2xl"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editing ? t.dialog.editTitle : t.dialog.registerTitle}
              </h2>
              <button
                type="button"
                onClick={close}
                className="rounded-lg p-1.5 text-muted transition hover:bg-white/[0.06] hover:text-ink"
                aria-label={t.dialog.close}
              >
                <X size={18} />
              </button>
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">{t.dialog.name}</span>
              <input
                required
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                className="w-full rounded-lg border border-line bg-stage px-3 py-2.5
                           text-sm outline-none transition focus:border-indigo-500
                           focus:ring-2 focus:ring-indigo-500/20"
                placeholder={t.dialog.namePlaceholder}
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">
                {t.dialog.description}
              </span>
              <textarea
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                rows={2}
                className="w-full resize-none rounded-lg border border-line bg-stage
                           px-3 py-2.5 text-sm outline-none transition focus:border-indigo-500
                           focus:ring-2 focus:ring-indigo-500/20"
                placeholder={t.dialog.descriptionPlaceholder}
              />
            </label>

            {!editing && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted">{t.dialog.scope}</span>
                  <select
                    value={form.scope}
                    onChange={(e) => set('scope', e.target.value as Scope)}
                    className="w-full rounded-lg border border-line bg-stage px-3 py-2.5 text-sm
                               outline-none focus:border-indigo-500"
                  >
                    <option value="tenant">{t.dialog.scopeOptions.tenant}</option>
                    <option value="global">{t.dialog.scopeOptions.global}</option>
                    <option value="private">{t.dialog.scopeOptions.private}</option>
                  </select>
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted">{t.dialog.transport}</span>
                  <select
                    value={form.transport}
                    onChange={(e) => set('transport', e.target.value as Transport)}
                    className="w-full rounded-lg border border-line bg-stage px-3 py-2.5 text-sm
                               outline-none focus:border-indigo-500"
                  >
                    <option value="streamable_http">Streamable HTTP</option>
                    <option value="sse">SSE</option>
                    <option value="stdio">stdio</option>
                  </select>
                </label>
              </div>
            )}

            {form.transport === 'stdio' ? (
              <>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted">
                    {t.dialog.command}
                  </span>
                  <input
                    value={form.command}
                    onChange={(e) => set('command', e.target.value)}
                    className="w-full rounded-lg border border-line bg-stage px-3 py-2.5
                               font-mono text-sm outline-none focus:border-indigo-500"
                    placeholder="node"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted">
                    {t.dialog.args}
                  </span>
                  <input
                    value={form.args}
                    onChange={(e) => set('args', e.target.value)}
                    className="w-full rounded-lg border border-line bg-stage px-3 py-2.5
                               font-mono text-sm outline-none focus:border-indigo-500"
                    placeholder="/pfad/zu/server.js --port 3001"
                  />
                  <span className="block text-xs text-faint">{t.dialog.argsHint}</span>
                </label>
              </>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">{t.dialog.url}</span>
                <input
                  type="url"
                  value={form.url}
                  onChange={(e) => set('url', e.target.value)}
                  className="w-full rounded-lg border border-line bg-stage px-3 py-2.5
                             text-sm outline-none focus:border-indigo-500"
                  placeholder="https://mcp.example.com/rpc"
                />
              </label>
            )}

            {/* ── Custom headers section (independent of auth type) ── */}
            <fieldset className="space-y-3 rounded-xl border border-line bg-stage/60 p-4">
              <legend className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
                {t.dialog.customHeaders}
              </legend>
              <p className="text-xs leading-relaxed text-faint">
                {t.dialog.customHeadersHint}
              </p>

              {headerRows.length > 0 && (
                <ul className="space-y-2">
                  {headerRows.map((row, index) => (
                    <li key={index} className="flex items-center gap-2">
                      <input
                        value={row.key}
                        onChange={(e) =>
                          setHeaderRows((rows) =>
                            rows.map((r, i) =>
                              i === index ? { ...r, key: e.target.value } : r,
                            ),
                          )
                        }
                        aria-label={`${t.dialog.headerName} ${index + 1}`}
                        placeholder="x-tenant-id"
                        className="w-full min-w-0 flex-1 rounded-lg border border-line bg-stage
                                   px-3 py-2 font-mono text-sm outline-none transition
                                   focus:border-indigo-500"
                      />
                      <span aria-hidden="true" className="shrink-0 text-faint">=</span>
                      <input
                        value={row.value}
                        onChange={(e) =>
                          setHeaderRows((rows) =>
                            rows.map((r, i) =>
                              i === index ? { ...r, value: e.target.value } : r,
                            ),
                          )
                        }
                        aria-label={`${t.dialog.headerValue} ${index + 1}`}
                        className="w-full min-w-0 flex-1 rounded-lg border border-line bg-stage
                                   px-3 py-2 font-mono text-sm outline-none transition
                                   focus:border-indigo-500"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setHeaderRows((rows) => rows.filter((_, i) => i !== index))
                        }
                        aria-label={`Header ${row.key || index + 1} entfernen`}
                        className="shrink-0 rounded-lg p-2 text-faint transition
                                   hover:bg-red-500/10 hover:text-red-400"
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <button
                type="button"
                onClick={() => setHeaderRows((rows) => [...rows, { key: '', value: '' }])}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2
                           text-xs font-medium text-muted transition hover:border-action/50
                           hover:text-indigo-300"
              >
                <Plus size={13} />
                {t.dialog.addHeader}
              </button>
            </fieldset>

            {/* ── Auth section ── */}
            <fieldset className="space-y-3.5 rounded-xl border border-line bg-stage/60 p-4">
              <legend className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
                <KeyRound size={12} />
                {t.dialog.auth}
              </legend>

              <label className="block space-y-1.5">
                <span className="text-sm text-muted">{t.dialog.authType}</span>
                <select
                  value={form.authType}
                  onChange={(e) => set('authType', e.target.value as AuthType)}
                  className="w-full rounded-lg border border-line bg-stage px-3 py-2.5 text-sm
                             outline-none focus:border-indigo-500"
                >
                  <option value="none">{t.dialog.authOptions.none}</option>
                  <option value="bearer">{t.dialog.authOptions.bearer}</option>
                  <option value="api_key">{t.dialog.authOptions.api_key}</option>
                  <option value="custom_headers">{t.dialog.authOptions.custom_headers}</option>
                  <option value="oauth2">{t.dialog.authOptions.oauth2}</option>
                </select>
              </label>

              {needsSecret && !isOAuth && (
                <>
                  {/* segmented control: reference vs direct entry */}
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-stage p-1
                                  ring-1 ring-line">
                    {(
                      [
                        ['ref', t.dialog.secretModeRef],
                        ['direct', t.dialog.secretModeDirect],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => set('secretMode', mode)}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                          form.secretMode === mode
                            ? 'bg-indigo-600 text-white'
                            : 'text-muted hover:text-ink'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {form.secretMode === 'ref' ? (
                    <label className="block space-y-1.5">
                      <span className="text-sm text-muted">{t.dialog.secretVarName}</span>
                      <input
                        value={form.secretRef}
                        onChange={(e) => set('secretRef', e.target.value)}
                        className="w-full rounded-lg border border-line bg-stage px-3
                                   py-2.5 font-mono text-sm outline-none focus:border-indigo-500"
                        placeholder="TV_API_KEY"
                      />
                      <span className="block text-xs text-faint">{t.dialog.secretVarHint}</span>
                    </label>
                  ) : (
                    <label className="block space-y-1.5">
                      <span className="text-sm text-muted">{t.dialog.secret}</span>
                      <input
                        type="password"
                        value={form.secretPlaintext}
                        onChange={(e) => set('secretPlaintext', e.target.value)}
                        autoComplete="off"
                        className="w-full rounded-lg border border-line bg-stage px-3
                                   py-2.5 text-sm outline-none focus:border-indigo-500"
                        placeholder="••••••••••••"
                      />
                      <span className="block text-xs text-faint">{t.dialog.secretEncHint}</span>
                    </label>
                  )}
                </>
              )}

              {form.authType === 'api_key' && (
                <label className="block space-y-1.5">
                  <span className="text-sm text-muted">{t.dialog.headerNameField}</span>
                  <input
                    value={form.headerName}
                    onChange={(e) => set('headerName', e.target.value)}
                    className="w-full rounded-lg border border-line bg-stage px-3 py-2.5
                               font-mono text-sm outline-none focus:border-indigo-500"
                    placeholder="x-api-key"
                  />
                </label>
              )}

              {isOAuth && (
                <div className="space-y-3">
                  <label className="block space-y-1.5">
                    <span className="text-sm text-muted">{t.dialog.tokenUrl}</span>
                    <input
                      type="url"
                      value={form.tokenUrl}
                      onChange={(e) => set('tokenUrl', e.target.value)}
                      className="w-full rounded-lg border border-line bg-stage px-3 py-2.5
                                 text-sm outline-none focus:border-indigo-500"
                      placeholder="https://idp.example.com/oauth/token"
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-sm text-muted">{t.dialog.clientId}</span>
                    <input
                      value={form.clientId}
                      onChange={(e) => set('clientId', e.target.value)}
                      className="w-full rounded-lg border border-line bg-stage px-3 py-2.5
                                 text-sm outline-none focus:border-indigo-500"
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-stage p-1 ring-1 ring-line">
                    {(
                      [
                        ['ref', t.dialog.secretModeRef],
                        ['direct', t.dialog.secretModeDirect],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() =>
                          set(
                            'secretMode',
                            mode === 'direct' ? 'direct' : 'ref',
                          )
                        }
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                          (mode === 'direct') === (form.secretMode === 'direct')
                            ? 'bg-indigo-600 text-white'
                            : 'text-muted hover:text-ink'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {form.secretMode === 'ref' ? (
                    <label className="block space-y-1.5">
                      <span className="text-sm text-muted">{t.dialog.clientSecretEnv}</span>
                      <input
                        value={form.clientSecretRef}
                        onChange={(e) => set('clientSecretRef', e.target.value)}
                        className="w-full rounded-lg border border-line bg-stage px-3
                                   py-2.5 font-mono text-sm outline-none focus:border-indigo-500"
                        placeholder="TV_CLIENT_SECRET"
                      />
                    </label>
                  ) : (
                    <label className="block space-y-1.5">
                      <span className="text-sm text-muted">{t.dialog.clientSecret}</span>
                      <input
                        type="password"
                        value={form.clientSecretPlaintext}
                        onChange={(e) => set('clientSecretPlaintext', e.target.value)}
                        autoComplete="off"
                        className="w-full rounded-lg border border-line bg-stage px-3
                                   py-2.5 text-sm outline-none focus:border-indigo-500"
                        placeholder="••••••••••••"
                      />
                    </label>
                  )}
                </div>
              )}
            </fieldset>

            {error && (
              <p className="rounded-lg bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={close}
                className="rounded-lg px-4 py-2.5 text-sm text-muted transition hover:text-ink"
              >
                {t.dialog.cancel}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5
                           py-2.5 text-sm font-semibold text-white shadow-sm
                           shadow-indigo-600/30 transition hover:bg-indigo-500
                           disabled:opacity-50"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                {editing ? t.dialog.save : t.app.register}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
