import type {
  AskPreset,
  AskResponse,
  BootstrapResponse,
  MemoryPulse,
  RecentMemoryItem,
} from '../api';
import {
  AskIcon,
  CalendarIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  CloseIcon,
  DocumentIcon,
  EllipsisIcon,
  PlusIcon,
  SearchLineIcon,
} from '../icons';

interface AskViewProps {
  bootstrap: BootstrapResponse | null;
  memoryPulse: MemoryPulse | null;
  question: string;
  selectedPresetId: string | null;
  result: AskResponse | null;
  loading: boolean;
  error: string | null;
  mobile: boolean;
  onQuestionChange: (value: string) => void;
  onSelectPreset: (preset: AskPreset) => void;
  onAsk: () => void;
  onOpenDrawer: () => void;
  onOpenKnowledge: () => void;
  onSeed: () => void;
}

function RecentMemoryList({
  items,
  onOpenKnowledge,
}: {
  items: RecentMemoryItem[];
  onOpenKnowledge: () => void;
}) {
  return (
    <section className="panel-section">
      <div className="panel-section__header">
        <h3>Recent memory</h3>
        <button className="text-button" type="button" onClick={onOpenKnowledge}>
          View all
        </button>
      </div>
      <ul className="memory-list">
        {items.map((item) => (
          <li key={item.id} className="memory-row">
            <div className="memory-row__icon" aria-hidden="true">
              <DocumentIcon size={18} />
            </div>
            <div className="memory-row__content">
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
            <time className="memory-row__date">{item.dateLabel}</time>
            <button className="icon-button icon-button--ghost" type="button" aria-label="More actions">
              <EllipsisIcon size={18} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AskView({
  bootstrap,
  memoryPulse,
  question,
  selectedPresetId,
  result,
  loading,
  error,
  mobile,
  onQuestionChange,
  onSelectPreset,
  onAsk,
  onOpenDrawer,
  onOpenKnowledge,
  onSeed,
}: AskViewProps) {
  const presets = bootstrap?.askPresets ?? [];
  const recentMemory = bootstrap?.recentMemory ?? [];
  const showSeed = recentMemory.length === 0 && (bootstrap?.rules.length ?? 0) === 0;

  return (
    <div className="ask-view">
      <section className="hero-panel">
        <h1>What do you want to remember?</h1>
        <div className="ask-composer">
          <div className="ask-input-frame">
            <label className="sr-only" htmlFor="ask-input">
              Ask memory
            </label>
            <input
              id="ask-input"
              value={question}
              onChange={(event) => onQuestionChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  onAsk();
                }
              }}
              placeholder="Who is collaborating on Atlas?"
              autoComplete="off"
            />
            {mobile && question.length > 0 ? (
              <button
                className="icon-button icon-button--ghost ask-input-frame__clear"
                type="button"
                aria-label="Clear question"
                onClick={() => onQuestionChange('')}
              >
                <CloseIcon size={22} />
              </button>
            ) : (
              <div className="ask-input-frame__meta" aria-hidden="true">
                <span className="ask-input-frame__shortcut">⌘ K</span>
              </div>
            )}
          </div>
          {!mobile ? (
            <>
              <div className="preset-strip" aria-label="Prompt presets">
                <span>Try asking</span>
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    className={`chip-button${selectedPresetId === preset.id ? ' chip-button--active' : ''}`}
                    type="button"
                    onClick={() => onSelectPreset(preset)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="ask-actions">
                <button className="primary-button" type="button" onClick={onAsk} disabled={loading}>
                  <AskIcon size={20} />
                  Ask memory
                </button>
                <button className="secondary-button" type="button" onClick={onOpenDrawer}>
                  <PlusIcon size={20} />
                  Add memory
                </button>
              </div>
            </>
          ) : (
            <div className="ask-actions ask-actions--mobile">
              <button className="primary-button" type="button" onClick={onAsk} disabled={loading}>
                <AskIcon size={24} />
                Ask memory
              </button>
              <button className="secondary-button" type="button" onClick={onOpenDrawer}>
                <PlusIcon size={24} />
                Add
              </button>
            </div>
          )}
        </div>
      </section>

      {error ? <p className="inline-error">{error}</p> : null}
      {loading ? <p className="inline-status">Thinking through local memory…</p> : null}

      {result ? (
        <section
          className={`answer-card${result.status === 'answered' ? '' : ' answer-card--no-match'}`}
        >
          <div className="answer-card__eyebrow">
            <code>{result.query}</code>
            {!mobile ? <ChevronDownIcon size={20} /> : null}
          </div>
          <div className="answer-card__body">
            <p className="answer-card__answer">{result.answer}</p>
            {result.status !== 'answered' ? (
              <p className="answer-card__boundary">
                Nothing in the current snapshot proves this. Related knowledge below is
                context, not an answer.
              </p>
            ) : null}
            {result.claims.length > 0 ? (
              <div className="answer-card__section">
                <h3>Because</h3>
                <ol className="proof-list">
                  {result.claims.map((claim, index) => (
                    <li key={claim.id}>
                      <span className="proof-list__index">{index + 1}</span>
                      <code>{claim.clause}</code>
                      {mobile ? <DocumentIcon size={20} /> : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {result.sources.length > 0 ? (
              <div className="answer-card__section">
                <h3>{mobile ? 'Sources' : 'Source'}</h3>
                <ul className="source-list">
                  {result.sources.map((source) => (
                    <li key={source.id}>
                      {mobile ? <CalendarIcon size={22} /> : <DocumentIcon size={18} />}
                      <div>
                        <strong>{source.label}</strong>
                        <span>{source.dateLabel}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <details className="answer-card__section answer-card__section--details" open={!mobile}>
              <summary>
                <h3>Related knowledge</h3>
                <ChevronDownIcon size={20} />
              </summary>
              {result.relatedKnowledge.length > 0 ? (
                <ul className="related-list">
                  {result.relatedKnowledge.map((item) => (
                    <li key={item.id}>
                      <code>{item.clause}</code>
                      <span>{item.sourcePreview}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-copy">No adjacent knowledge matched this question.</p>
              )}
            </details>
          </div>
        </section>
      ) : (
        <section className="empty-panel">
          <p>
            Ask a memory question to inspect deterministic answers, supporting claims, and
            the connected graph.
          </p>
          {showSeed ? (
            <button className="secondary-button" type="button" onClick={onSeed}>
              <SearchLineIcon size={20} />
              Seed demo memory
            </button>
          ) : null}
        </section>
      )}

      {mobile && memoryPulse ? (
        <section className="mobile-pulse-card">
          <div className="mobile-pulse-card__header">
            <SearchLineIcon size={22} />
            <div>
              <strong>Memory pulse</strong>
              <span>
                {memoryPulse.factCount} facts · {memoryPulse.ruleCount} rules ·{' '}
                {memoryPulse.healthLabel}
              </span>
            </div>
            <ChevronRightIcon size={22} />
          </div>
        </section>
      ) : null}

      {recentMemory.length > 0 ? (
        <RecentMemoryList items={recentMemory} onOpenKnowledge={onOpenKnowledge} />
      ) : null}
    </div>
  );
}
