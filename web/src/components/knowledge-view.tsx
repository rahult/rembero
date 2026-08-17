import type { BootstrapResponse, SearchKind, SearchResponse } from '../api';
import { SearchLineIcon } from '../icons';

interface KnowledgeViewProps {
  bootstrap: BootstrapResponse | null;
  query: string;
  kind: SearchKind | 'all';
  result: SearchResponse | null;
  loading: boolean;
  error: string | null;
  onQueryChange: (value: string) => void;
  onKindChange: (value: SearchKind | 'all') => void;
}

const FILTERS: Array<SearchKind | 'all'> = ['all', 'fact', 'rule', 'constraint'];

export function KnowledgeView({
  bootstrap,
  query,
  kind,
  result,
  loading,
  error,
  onQueryChange,
  onKindChange,
}: KnowledgeViewProps) {
  const items =
    query.trim().length === 0
      ? bootstrap?.knowledgeHighlights ?? []
      : result?.results ?? [];
  const status = query.trim().length === 0 ? null : result?.status ?? 'no_match';

  return (
    <div className="knowledge-view">
      <section className="view-header">
        <div>
          <h1>Knowledge</h1>
          <p>Search facts, rules, constraints, and grounded provenance from the local store.</p>
        </div>
      </section>

      <section className="search-panel">
        <label className="search-field">
          <span className="sr-only">Search knowledge</span>
          <SearchLineIcon size={20} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search projects, people, rules, or source text"
          />
        </label>
        <div className="filter-row" role="toolbar" aria-label="Knowledge filters">
          {FILTERS.map((value) => (
            <button
              key={value}
              className={`chip-button${kind === value ? ' chip-button--active' : ''}`}
              type="button"
              onClick={() => onKindChange(value)}
            >
              {value === 'all'
                ? 'All'
                : value === 'constraint'
                  ? 'Policy'
                  : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`}
            </button>
          ))}
        </div>
      </section>

      {loading ? <p className="inline-status">Searching local knowledge…</p> : null}
      {error ? <p className="inline-error">{error}</p> : null}

      <section className="knowledge-results">
        <div className="panel-section__header">
          <h3>{query.trim().length === 0 ? 'Highlights' : 'Results'}</h3>
          {status === 'matches' ? <span>{items.length} matches</span> : null}
        </div>
        {items.length > 0 ? (
          <ul className="knowledge-grid">
            {items.map((item) => (
              <li key={item.id} className="knowledge-card">
                <div className="knowledge-card__meta">
                  <span className="pill">
                    {item.kind === 'constraint'
                      ? 'Policy'
                      : `${item.kind.slice(0, 1).toUpperCase()}${item.kind.slice(1)}`}
                  </span>
                  <span>{item.reasonSummary} · score {item.score}</span>
                </div>
                <code>{item.clause}</code>
                <p>{item.sourcePreview}</p>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-panel">
            <p>
              {query.trim().length === 0
                ? 'No search highlights are available yet.'
                : 'No local clauses matched this search.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
