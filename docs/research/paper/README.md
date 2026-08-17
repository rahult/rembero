# Paper build

The canonical source is `paper.md`; citations are in `references.bib`.

Build a self-contained review copy with Pandoc:

```bash
cd docs/research/paper
pandoc paper.md --citeproc --standalone --embed-resources --output paper.html
```

The first public submission should keep the disclosure and limitations intact. Before a
venue submission, select the venue template, replace the Markdown table numbering with the
template's native format, add an artifact-availability statement, and archive the exact
repository commit plus benchmark result JSON.
