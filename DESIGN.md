---
name: Remembero
description: Proof-carrying memory presented as a precise, inspectable evidence ledger.
colors:
  ink: "#071525"
  ink-soft: "#10233d"
  cobalt: "#145dff"
  cobalt-deep: "#0c4ddd"
  provenance-amber: "#e99812"
  provenance-wash: "#fff5df"
  text-muted: "#5f6b7b"
  line: "#d7dee8"
  line-dark: "#2b405c"
  paper: "#ffffff"
  paper-soft: "#f7f9fc"
typography:
  display:
    fontFamily: "var(--font-geist-sans), Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(4.4rem, 6.7vw, 7rem)"
    fontWeight: 720
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  body:
    fontFamily: "var(--font-geist-sans), Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "var(--font-geist-mono), SFMono-Regular, Consolas, monospace"
    fontSize: "0.9rem"
    fontWeight: 500
    lineHeight: 1.6
  evidence:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "clamp(1.8rem, 2.7vw, 2.7rem)"
    fontWeight: 400
    lineHeight: 1.15
rounded:
  control: "8px"
  panel: "10px"
  soft-panel: "14px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "20px"
  lg: "32px"
  xl: "48px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "0 24px"
    height: "50px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 24px"
    height: "50px"
  evidence-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "20px 26px"
---

# Design System: Remembero

## Overview

**Creative North Star: “The Proof Ledger”**

Remembero’s visual system makes technical causality legible. Large, direct sans-serif
statements establish product confidence; monospaced data and query surfaces show the
mechanism; a restrained serif voice marks human-readable answers and evidence. The page
is predominantly white with navy structural bands, cobalt for action and execution, and
amber used sparingly to trace provenance.

The system is editorial in hierarchy but operational in detail. It avoids decorative
technical theater: every line, node, status, and accent should explain data, control, or
support.

**Key Characteristics:**

- White evidence surfaces against deep navy structural fields.
- Cobalt means action or active execution; amber means source or proof.
- Large typography introduces the idea, while precise tables and code prove it.
- Graphs are projections of the same evidence and always have a readable list equivalent.

## Colors

The palette is high-contrast and cool, with one warm provenance color.

### Primary

- **Execution Cobalt** (`#145dff`): primary actions, selected states, query emphasis, and
  focus indication.
- **Ledger Ink** (`#071525`): primary text and full-width structural bands.

### Secondary

- **Provenance Amber** (`#e99812`): proof edges, sources, and derivation emphasis only.

### Neutral

- **Paper** (`#ffffff`): primary working surface.
- **Soft Paper** (`#f7f9fc`): quiet secondary regions and inactive data rows.
- **Muted Slate** (`#5f6b7b`): explanatory text and metadata.
- **Ledger Line** (`#d7dee8`): dividers, table rules, and low-emphasis boundaries.
- **Night Line** (`#2b405c`): dividers on navy surfaces.

### Named Rules

**The Evidence Color Rule.** Amber never decorates. It appears only where a user can trace
an answer to a source, rule, or proof edge.

## Typography

**Display Font:** Geist Sans with Helvetica Neue and Arial fallbacks

**Body Font:** Geist Sans with Helvetica Neue and Arial fallbacks

**Label/Mono Font:** Geist Mono with SFMono-Regular and Consolas fallbacks
**Evidence Accent:** Georgia with Times New Roman fallback

**Character:** The sans system is compact and declarative. Mono is reserved for real code,
data, identifiers, and measurement. Serif is a semantic change of voice for the answer a
human reads, never a general decorative display face.

### Hierarchy

- **Display** (720, `clamp(4.4rem, 6.7vw, 7rem)`, 0.98): product thesis.
- **Headline** (720, `clamp(3.2rem, 5.5vw, 5.7rem)`, 0.98): major sections.
- **Title** (650, 1.25–1.5rem, 1.2): panels and working regions.
- **Body** (400, 1rem, 1.5): explanation with a maximum measure near 70 characters.
- **Label** (720, 0.76rem, 0.08em, uppercase): field names and evidence anatomy.
- **Code** (500, 0.86–1rem, 1.6): SQL, Datalog, row values, and runtime output.

## Layout

Marketing sections use a centered rail up to 1280px with 48px minimum outer gutters and
96px vertical section rhythm. Product demonstrations use asymmetric working grids rather
than repeated cards. Desktop may hold persistent data, editor, and inspector bands; mobile
reduces them to one active pane with context retained in a sticky control row.

### Site architecture

The homepage is an editorial product surface: brand promise, proof-carrying example,
positioning, product preview, operating model, and calls to action. The full IDE is a
separate `/playground` route linked from the desktop navigation, mobile menu, hero,
product preview, final action, and footer. Do not place the full-height IDE before the
homepage story or duplicate it inline on the homepage.

### Shipped IDE topology

Desktop keeps four simultaneous authorities visible: schema and guidance on the left,
stored rows and query execution in the centre, proof and graph on the right, and native
runtime status below. Mobile turns the same topology into **Data → Query → Proof → Graph**
tabs; running a rule advances to Proof automatically without erasing the active database.

The learning sequence is deliberately database-first:

1. insert or inspect an ordinary SQLite row;
2. start from a prepared human question, then reveal its Datalog rule;
3. select a derived row;
4. trace the exact SQLite facts, applied rule, and query-scoped graph.

Advanced surfaces—SQL scratchpad, constraints, recursive examples, raw JSON, compiled
SQL, and build hashes—remain available in-place but do not compete with the first proof.

### Shipped developer-lab topology

The labs are developer workbenches, not chat mockups. At ordinary laptop widths the
user-facing result and the machinery that produced it remain visible together.

The chat-memory workbench exposes two complete model tool loops over one browser-local
SQLite database. Both lanes expose the same `Query({query})` interface. The data-only lane
shows its SQL adapter, executed prepared SQL, and raw rows. The Remembero lane shows its
Remembero adapter, executed Datalog, bindings, and proof. A shared-runtime column makes the single data
authority explicit, while the contract column keeps both final raw outputs and proof visible.
The tool ledgers precede the polished answers when the layout must stack.

The grounded-agent workbench keeps four persistent columns: structured request, prompt-only
proposal, memory-enriched proposal, and deterministic decision proof. The proof region shows
the proposed-action fact, gate query, active rule, proof chain, and final authorization. It
becomes the first workbench region at narrow widths. The model may propose an action, but
only the proof-carrying gate may approve, block, or escalate it.

Both labs label whether model prose came from a ready browser-local language model or the
deterministic simulator. Developers can explicitly load the optional Hermes 2 Pro Mistral 7B
WebLLM model; the chat lab uses native `tools` and forced `tool_choice`, then shows the
validated call and tool result in the final synthesis prompt. Real
SQLite, SQL, Remembero rule evaluation, and proof generation run in the browser. The SQLite playground shows current-browser timings beside the
native runtime identity; those numbers are measurements of the active seeded case, not a
cross-device benchmark.

## Elevation & Depth

The system is flat by default. Hierarchy comes from tonal fields, 1px rules, typography,
and panel adjacency rather than soft floating-card shadows. Focus or selected state may
use a short offset shadow only when it improves keyboard or spatial orientation.

## Shapes

Controls use an 8px radius, evidence frames use 10px, and larger composed surfaces may use
14px. Circular shapes are reserved for proof-step markers and graph nodes. Borders are
thin and structural; thick side accents and ornamental pills do not belong.

## Components

### Buttons

- **Shape:** compact rectangle with 8px corners and at least 44px height.
- **Primary:** cobalt field, white label, darkens to cobalt-deep on hover.
- **Secondary:** white field with ink border; cobalt border and text on hover.
- **Focus:** visible 2px cobalt ring with offset; never focus-by-color alone.

### Cards / Containers

- **Corner Style:** 10px for evidence frames, 14px only for large composed tools.
- **Background:** paper or soft paper; navy is a full band, not a nested card.
- **Shadow Strategy:** none at rest.
- **Border:** 1px ledger line or night line.
- **Internal Padding:** 20–26px for ordinary evidence, denser in data tables and IDE chrome.

### Inputs / Fields

- **Style:** paper background, ink text, thin ledger border, 8px corners.
- **Focus:** cobalt border and focus ring.
- **Error / Disabled:** explicit text plus state color; disabled controls retain readable
  contrast and explain why they are unavailable.

### Navigation

Navigation is quiet, typographic, and sparse. Active state uses cobalt and a precise line,
not a filled capsule. Mobile navigation remains keyboard-accessible and keeps the primary
task visible.

### Proof Chain

Proof steps are an ordered ledger: source facts first, authored rule next, derived answer
last. Amber markers and connecting lines express support. Every visual graph selection
mirrors to the ordered proof list.

### Runtime truth boundary

- The browser demo runs SQLite 3.53.4 WebAssembly with the Remembero C extension registered
  statically through `sqlite3_auto_extension`; it never implies dynamic extension loading.
- Rows live in an in-memory, reload-reset SQLite database. Nothing is uploaded or persisted.
- Results, proof ladders, and graphs come from one execution; derived answers are not stored.
- Recursive rules use the extension's native fixpoint evaluator and must not be described as
  one compiled SQL statement.
- Integrity constraints shown in the IDE are an explicit governed-memory boundary, not a
  capability of the browser SQLite bridge.

### Accessibility and interaction invariants

- Every icon-only control needs an accessible name, and every graph needs its ordered-list
  equivalent.
- Keyboard focus remains visible; Datalog and SQL run with Ctrl/Command + Enter.
- State changes use text and structure in addition to color. Proof facts precede the rule,
  and the rule precedes the answer in both visual and reading order.
- Do not replace the mobile pane model with a scaled-down desktop grid.

## Do's and Don'ts

### Do:

- **Do** make the storage, query, result, and proof relationship visible together.
- **Do** reserve cobalt for actions and amber for provenance.
- **Do** keep code and data code-native, selectable, and keyboard reachable.
- **Do** pair any graph with an ordered textual representation.

### Don't:

- **Don't** use generic dashboard cards as the primary page structure.
- **Don't** add fake metrics, server activity, model calls, or stored derived facts.
- **Don't** use amber as a decorative highlight or gradient.
- **Don't** hide an unsupported or empty result behind plausible prose.
