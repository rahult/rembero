# Migrating to 0.55

Version 0.55 aligns the npm and command-line names with the Remembero product.

## Install and import

Use the new package name:

```bash
npm install -g remembero
npx -y remembero --help
```

```ts
import { MemoryStore, retrieveQuestion } from 'remembero';
```

The primary local web-console executable is now `remembero-web`.

## Compatibility

The `remembero` package also installs `rembero` and `rembero-web` executable aliases for
a compatibility window. No memory migration is required: `REMBERO_*` environment
variables, `.rembero` and `.rembero-web` data directories, Claude hook markers,
content-addressed bundle/protocol identifiers, and native SQLite filenames and symbols
remain stable. These are persisted integration contracts rather than public brand text.
