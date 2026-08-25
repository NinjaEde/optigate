import { useState } from 'react';
import {
  CircleCheck,
  CircleAlert,
  CircleX,
  Clock,
  Globe,
  Users,
  Lock,
  RefreshCw,
  Trash2,
  Ban,
  Pencil,
  KeyRound,
  PlugZap,
  Unplug,
  ChevronDown,
  Loader2,
} from 'lucide-react';

import { api, type MCPServer, type ToolMeta } from '../api';
import { useT } from '../i18n';

const VISIBLE_TOOLS = 4;

const statusIcons: Record<
  MCPServer['status'],
  { icon: typeof CircleCheck; cls: string }
> = {
  healthy: { icon: CircleCheck, cls: 'text-signal' },
  degraded: { icon: CircleAlert, cls: 'text-amber-400' },
  offline: { icon: CircleX, cls: 'text-red-400' },
  disabled: { icon: Ban, cls: 'text-muted' },
  pending_approval: { icon: Clock, cls: 'text-amber-300' },
};

const scopeStyles: Record<MCPServer['scope'], { icon: typeof Globe; cls: string }> = {
  global: { icon: Globe, cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  tenant: { icon: Users, cls: 'text-indigo-300 bg-action/10 border-action/25' },
  private: { icon: Lock, cls: 'text-violet-300 bg-violet-500/10 border-violet-500/20' },
};

const authLabels: Record<string, string> = {
  bearer: 'Bearer',
  api_key: 'API Key',
  custom_headers: 'Headers',
  oauth2: 'OAuth2',
};

interface Props {
  server: MCPServer;
  tools?: ToolMeta[];
  onChanged: () => void;
  onEdit: (id: string) => void;
  onValidated: (id: string, tools: ToolMeta[]) => void;
}

export function ServerCard({ server: s, tools, onChanged, onEdit, onValidated }: Props) {
  const t = useT();
  const status = statusIcons[s.status];
  const StatusIcon = status.icon;
  const scope = scopeStyles[s.scope];
  const ScopeIcon = scope.icon;
  const authType = s.connection.auth?.type ?? 'none';

  const [validating, setValidating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const toolList = tools ?? [];
  const visibleTools = expanded ? toolList : toolList.slice(0, VISIBLE_TOOLS);
  const hiddenCount = toolList.length - VISIBLE_TOOLS;

  async function validate() {
    setValidating(true);
    setValidateError(null);

    try {
      const result = await api.validateServer(s.id);
      if (result.valid) {
        onValidated(s.id, result.tools);
      } else {
        setValidateError(result.error ?? 'Verbindung fehlgeschlagen');
      }
      onChanged();
    } catch (err) {
      setValidateError((err as Error).message);
    } finally {
      setValidating(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    setValidateError(null);

    try {
      await api.disconnectServer(s.id);
      onChanged();
    } catch (err) {
      setValidateError((err as Error).message);
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <article
      className="group relative flex flex-col overflow-hidden rounded-xl border border-line
                 bg-panel/80 p-5 transition duration-200
                 hover:border-action/40 hover:bg-panel"
    >
      {/* Signature: leuchtende Top-Kante bei Hover */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent
                   via-action/60 to-transparent opacity-0 transition duration-300 group-hover:opacity-100"
      />

      {/* status badge */}
      <span
        className={`absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full border
                    border-line bg-stage/70 px-2.5 py-1 text-xs font-medium backdrop-blur ${status.cls}`}
      >
        <StatusIcon size={13} />
        <span>{t.card.status[s.status]}</span>
      </span>

      <h3 className="mb-3 max-w-[65%] truncate font-display text-base font-semibold">{s.name}</h3>

      {s.description ? (
        <p className="mb-4 line-clamp-2 min-h-[2.5rem] text-sm leading-relaxed text-muted">
          {s.description}
        </p>
      ) : (
        <p className="mb-4 min-h-[2.5rem] text-sm italic text-faint">{t.card.noDescription}</p>
      )}

      {/* meta chips */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${scope.cls}`}>
          <ScopeIcon size={11} />
          {s.scope}
        </span>
        <span className="rounded-full border border-line bg-white/[0.03] px-2.5 py-1 font-mono text-xs text-muted">
          {s.transport.replace('_', '-')}
        </span>
        {authLabels[authType] && (
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-xs text-muted">
            <KeyRound size={10} />
            {authLabels[authType]}
          </span>
        )}
      </div>

      {/* tools section */}
      {toolList.length > 0 && (
        <div className="mb-4 rounded-lg border border-line/70 bg-stage/50 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted">
            {t.card.tools}
            <span className="rounded-full bg-action/15 px-1.5 py-0.5 font-mono text-[10px] normal-case text-indigo-300">
              {toolList.length}
            </span>
          </p>
          <ul className="space-y-1">
            {visibleTools.map((tool) => (
              <li key={tool.name} className="flex items-baseline gap-2 text-xs">
                <code className="font-mono text-indigo-300">{tool.name}</code>
                {tool.description && (
                  <span className="truncate text-faint">{tool.description}</span>
                )}
              </li>
            ))}
          </ul>

          {toolList.length > VISIBLE_TOOLS && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-400 transition hover:text-indigo-300"
            >
              <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
              {expanded ? t.card.less : `${hiddenCount} ${t.card.more}`}
            </button>
          )}
        </div>
      )}

      {/* validation error */}
      {validateError && (
        <p role="alert" className="mb-3 break-words rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-400">
          {validateError}
        </p>
      )}

      {/* actions */}
      <div className="mt-auto flex items-center gap-1 border-t border-line/60 pt-4">
        {s.status === 'healthy' ? (
          <button
            type="button"
            title={t.card.refreshTitle}
            onClick={() => void validate()}
            disabled={validating || disconnecting}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg
                       bg-action/90 px-3 py-2 text-xs font-medium text-white
                       transition hover:bg-indigo-500 disabled:opacity-60"
          >
            {validating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {validating ? t.card.loading : t.card.refreshTools}
          </button>
        ) : s.status === 'disabled' ? (
          <button
            type="button"
            title={t.card.enableTitle}
            onClick={async () => {
              await api.enableServer(s.id);
              onChanged();
            }}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg
                       border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs
                       font-medium text-emerald-400 transition hover:bg-emerald-500/20"
          >
            <CircleCheck size={13} />
            {t.card.enable}
          </button>
        ) : (
          <button
            type="button"
            title={t.card.connectTitle}
            onClick={() => void validate()}
            disabled={validating || disconnecting}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg
                       bg-action/90 px-3 py-2 text-xs font-medium text-white
                       transition hover:bg-indigo-500 disabled:opacity-60"
          >
            {validating ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
            {validating ? t.card.connecting : t.card.connect}
          </button>
        )}

        {s.status === 'healthy' && (
          <button
            type="button"
            title={t.card.disconnectTitle}
            aria-label={`${s.name}: ${t.card.disconnect}`}
            onClick={() => void disconnect()}
            disabled={disconnecting || validating}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs
                       font-medium text-muted transition hover:bg-white/[0.06]
                       hover:text-amber-400 disabled:opacity-50"
          >
            {disconnecting ? <Loader2 size={13} className="animate-spin" /> : <Unplug size={13} />}
            {t.card.disconnect}
          </button>
        )}

        <button
          type="button"
          title={t.card.edit}
          aria-label={`${s.name}: ${t.card.edit}`}
          onClick={() => onEdit(s.id)}
          className="rounded-lg p-2 text-muted transition hover:bg-white/[0.06] hover:text-indigo-400"
        >
          <Pencil size={14} />
        </button>

        {s.status === 'pending_approval' && (
          <button
            type="button"
            title={t.card.approve}
            aria-label={`${s.name}: ${t.card.approve}`}
            onClick={async () => {
              await api.approveServer(s.id);
              onChanged();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs
                       font-medium text-emerald-400 transition hover:bg-emerald-500/10"
          >
            <Clock size={13} />
            {t.card.approve}
          </button>
        )}

        {s.status === 'healthy' && (
          <button
            type="button"
            title={t.card.disable}
            aria-label={`${s.name}: ${t.card.disable}`}
            onClick={async () => {
              await api.disableServer(s.id);
              onChanged();
            }}
            className="rounded-lg p-2 text-faint transition hover:bg-white/[0.06] hover:text-amber-400"
          >
            <Ban size={15} />
          </button>
        )}

        <button
          type="button"
          title={t.card.delete}
          aria-label={`${s.name}: ${t.card.delete}`}
          onClick={async () => {
            if (!window.confirm('Server wirklich entfernen?')) {
              return;
            }
            await api.deleteServer(s.id);
            onChanged();
          }}
          className="ml-auto rounded-lg p-2 text-faint transition hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}
