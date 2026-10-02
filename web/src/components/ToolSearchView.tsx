import { useRef, useState } from 'react';
import { Search, Loader2, Wrench, Sparkles, TriangleAlert } from 'lucide-react';

import { api, type ToolMeta } from '../api';
import { useT } from '../i18n';

interface SearchResult extends ToolMeta {
  serverName: string;
  serverId: string;
  score: number;
  lexicalScore?: number;
}

interface DecisionMeta {
  used: boolean;
  provider?: string;
  none?: boolean;
  confidence?: number;
  fallback: string | null;
  latencyMs?: number;
  error?: string;
  forced?: boolean;
}

const LIMIT = 8;

type SearchMode = 'lexical' | 'decision';

/**
 * "Was sieht ein Agent?" — Tool-Suche über exakt denselben Retrieval-Pfad,
 * den auch die /mcp-Fassade für search_tools() nutzt. Demo-/Debug-Sicht
 * für die Retrieval-Qualität des Token-Optimierers.
 */
export function ToolSearchView() {
  const t = useT();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('lexical');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [decision, setDecision] = useState<DecisionMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // monotonically increasing id: only the latest request may settle state
  const requestId = useRef(0);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q) {
      return;
    }

    const id = ++requestId.current;
    const apply = (fn: () => void) => {
      if (requestId.current === id) {
        fn();
      }
    };

    setBusy(true);
    setError(null);
    setResults(null);
    setDecision(null);

    try {
      const res = await api.searchTools(q, LIMIT, mode);
      apply(() => {
        setResults(res.tools);
        setDecision(res.decision);
      });
    } catch (err) {
      apply(() => setError((err as Error).message));
    } finally {
      apply(() => setBusy(false));
    }
  }

  function switchMode(next: SearchMode) {
    setMode(next);
    // stale results belong to the other mode
    setResults(null);
    setDecision(null);
  }

  return (
    <section aria-label={t.toolSearch.heading} className="space-y-4">
      <header>
        <h2 className="font-display text-lg font-semibold">{t.toolSearch.heading}</h2>
        <p className="mt-0.5 text-sm text-muted">
          {t.toolSearch.intro1}{' '}
          <code className="rounded bg-action/10 px-1.5 py-0.5 font-mono text-xs text-indigo-300">
            search_tools()
          </code>{' '}
          {t.toolSearch.intro2}
        </p>
      </header>

      <form onSubmit={run} className="flex gap-2" role="search">
        <label className="relative flex-1">
          <span className="sr-only">{t.toolSearch.srLabel}</span>
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.toolSearch.placeholder}
            className="w-full rounded-lg border border-line bg-panel/60 py-2.5 pl-9 pr-3
                       font-mono text-sm text-ink outline-none transition
                       placeholder:text-faint focus:border-action/60"
          />
        </label>
        <div
          role="group"
          aria-label="search mode"
          title={t.toolSearch.modeHint}
          className="inline-flex items-center rounded-lg border border-line bg-panel/60 p-0.5 text-xs font-medium"
        >
          {(['lexical', 'decision'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              aria-pressed={mode === m}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-2 transition ${
                mode === m
                  ? 'bg-action text-white'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {m === 'decision' && <Sparkles size={12} aria-hidden="true" />}
              {m === 'lexical' ? t.toolSearch.modeLexical : t.toolSearch.modeDecision}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-action px-4 py-2.5
                     text-sm font-semibold text-white transition hover:bg-indigo-500
                     disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Search size={15} />
          )}
          {t.toolSearch.submit}
        </button>
      </form>

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}

      {results && (
        <div className="overflow-hidden rounded-xl border border-line bg-panel/80">
          <p className="border-b border-line px-5 py-3 text-xs uppercase tracking-wider text-muted">
            {results.length} {t.toolSearch.resultsHeader}
            {decision?.used && decision.provider && (
              <span className="ml-2 inline-flex items-center gap-1 normal-case tracking-normal text-indigo-300">
                <Sparkles size={11} aria-hidden="true" />
                {t.toolSearch.decisionUsed(decision.provider, decision.latencyMs ?? 0)}
              </span>
            )}
          </p>
          {decision && !decision.used && decision.fallback && mode === 'decision' && (
            <p className="flex items-center gap-2 border-b border-line bg-amber-500/10 px-5 py-2.5 text-xs text-amber-300">
              <TriangleAlert size={13} aria-hidden="true" className="shrink-0" />
              <span>
                {t.toolSearch.decisionFallback(decision.fallback)}
                {decision.error && (
                  <span className="mt-0.5 block font-mono text-amber-300/70">{decision.error}</span>
                )}
              </span>
            </p>
          )}
          {decision?.none && (
            <p className="border-b border-line bg-indigo-500/10 px-5 py-2.5 text-xs text-indigo-300">
              {t.toolSearch.decisionNone(decision.confidence ?? 0)}
            </p>
          )}
          <ul className="divide-y divide-line/50">
            {results.map((r) => (
              <li key={`${r.serverId}/${r.name}`} className="flex items-start gap-4 px-5 py-3.5">
                <span
                  className="mt-0.5 inline-flex min-w-[2.5rem] shrink-0 justify-center rounded-md
                             bg-action/15 px-1.5 py-1 font-mono text-xs font-semibold text-indigo-300"
                  title={
                    r.lexicalScore !== undefined
                      ? `${t.toolSearch.scoreTitle} · lexical ${r.lexicalScore}`
                      : t.toolSearch.scoreTitle
                  }
                >
                  {Number(r.score.toFixed(2))}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <code className="font-mono text-sm font-medium text-indigo-300">{r.name}</code>
                    <span className="text-xs text-faint">@</span>
                    <span className="text-xs font-medium text-muted">{r.serverName}</span>
                  </p>
                  {r.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
                      {r.description}
                    </p>
                  )}
                </div>
              </li>
            ))}
            {results.length === 0 && (
              <li className="flex items-center gap-3 px-5 py-10 text-center text-sm text-faint">
                <Wrench size={18} className="mx-auto shrink-0" />
                {t.toolSearch.empty}
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
