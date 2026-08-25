import { useState } from 'react';
import { Search, Loader2, Wrench } from 'lucide-react';

import { api, type ToolMeta } from '../api';
import { useT } from '../i18n';

interface SearchResult extends ToolMeta {
  serverName: string;
  serverId: string;
  score: number;
}

const LIMIT = 8;

/**
 * "Was sieht ein Agent?" — Tool-Suche über exakt denselben Retrieval-Pfad,
 * den auch die /mcp-Fassade für search_tools() nutzt. Demo-/Debug-Sicht
 * für die Retrieval-Qualität des Token-Optimierers.
 */
export function ToolSearchView() {
  const t = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const { tools } = await api.searchTools(q, LIMIT);
      setResults(tools);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
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
          </p>
          <ul className="divide-y divide-line/50">
            {results.map((r) => (
              <li key={`${r.serverId}/${r.name}`} className="flex items-start gap-4 px-5 py-3.5">
                <span
                  className="mt-0.5 inline-flex min-w-[2.5rem] shrink-0 justify-center rounded-md
                             bg-action/15 px-1.5 py-1 font-mono text-xs font-semibold text-indigo-300"
                  title="Relevanz-Score"
                >
                  {r.score}
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
