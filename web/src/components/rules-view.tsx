import type { BootstrapResponse } from '../api';
import { SearchLineIcon } from '../icons';

interface RulesViewProps {
  bootstrap: BootstrapResponse | null;
  onSeed: () => void;
}

export function RulesView({ bootstrap, onSeed }: RulesViewProps) {
  const rules = bootstrap?.rules ?? [];
  const findings = bootstrap?.healthFindings ?? [];

  return (
    <div className="rules-view">
      <section className="view-header">
        <div>
          <h1>Rules</h1>
          <p>Inspect the actual deterministic clauses governing derived memory behavior.</p>
        </div>
      </section>

      {rules.length === 0 ? (
        <div className="empty-panel">
          <p>No stored rules are available yet.</p>
          <button className="secondary-button" type="button" onClick={onSeed}>
            <SearchLineIcon size={18} />
            Seed demo memory
          </button>
        </div>
      ) : (
        <ul className="rule-list">
          {rules.map((rule) => (
            <li key={rule.id} className="rule-card">
              <div className="rule-card__meta">
                <span className={`pill${rule.status === 'review' ? ' pill--amber' : ''}`}>
                  {rule.status}
                </span>
                <span>{rule.sourceLabel}</span>
              </div>
              <code>{rule.clause}</code>
              <p>{rule.summary}</p>
            </li>
          ))}
        </ul>
      )}

      {findings.length > 0 ? (
        <section className="panel-section">
          <div className="panel-section__header">
            <h3>Health notes</h3>
          </div>
          <ul className="finding-list">
            {findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
