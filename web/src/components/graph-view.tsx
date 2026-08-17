import type { GraphResponse } from '../api';
import { ArrowUpRightIcon, SearchLineIcon } from '../icons';
import { GraphCanvas } from './graph-canvas';

interface GraphViewProps {
  graphResponse: GraphResponse | null;
  focusInput: string;
  loading: boolean;
  error: string | null;
  onFocusChange: (value: string) => void;
  onExplore: () => void;
  onSelectNode: (value: string) => void;
}

export function GraphView({
  graphResponse,
  focusInput,
  loading,
  error,
  onFocusChange,
  onExplore,
  onSelectNode,
}: GraphViewProps) {
  const graph = graphResponse?.graph ?? {
    focus: null,
    nodes: [],
    links: [],
    relationships: [],
  };
  const focusLabel = (graph.focus ?? focusInput).trim();
  const heading = focusLabel.length === 0
    ? 'Knowledge graph'
    : `${focusLabel.slice(0, 1).toUpperCase()}${focusLabel.slice(1)}’s neighborhood`;

  return (
    <div className="graph-view">
      <section className="view-header">
        <div>
          <div className="view-header__title">
            <h1>{heading}</h1>
            <span className="pill">Stored facts only</span>
          </div>
          <p>Explore explicit relationships and keep the list beside the SVG as the full ledger.</p>
        </div>
      </section>

      <section className="graph-toolbar">
        <label className="search-field">
          <span className="sr-only">Graph focus</span>
          <SearchLineIcon size={20} />
          <input
            value={focusInput}
            onChange={(event) => onFocusChange(event.target.value)}
            placeholder="Focus Atlas, Maya, Rahul, or Northstar"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onExplore();
              }
            }}
          />
        </label>
        <button className="primary-button" type="button" onClick={onExplore}>
          <ArrowUpRightIcon size={18} />
          Explore focus
        </button>
      </section>

      {loading ? <p className="inline-status">Loading graph neighborhood…</p> : null}
      {error ? <p className="inline-error">{error}</p> : null}

      <section className="graph-layout">
        <div className="graph-panel">
          <GraphCanvas graph={graph} onSelectNode={onSelectNode} />
        </div>
        <div className="relationship-panel">
          <div className="panel-section__header">
            <h3>Relationship list</h3>
            <span>{graph.relationships.length} entries</span>
          </div>
          {graph.relationships.length > 0 ? (
            <ul className="relationship-list">
              {graph.relationships.map((relationship) => (
                <li key={relationship.id}>
                  <strong>
                    {relationship.left}
                    {relationship.right ? ` → ${relationship.right}` : ''}
                  </strong>
                  <span>{relationship.label}</span>
                  <code>{relationship.clause}</code>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-panel">
              <p>No graph relationships are loaded for this focus yet.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
