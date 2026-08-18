#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sqlite_version=3.53.4
sqlite_number=3530400
sqlite_archive="sqlite-src-${sqlite_number}.zip"
sqlite_url="https://sqlite.org/2026/${sqlite_archive}"
sqlite_sha3=b834d474b9b393d85a9e3ee4cc11f1329e007e9376a424ee740796f5c4bda3a8
emsdk_image=emscripten/emsdk:6.0.4
work_root="$project_root/build/sqlite-wasm"
source_root="$work_root/sqlite-src-${sqlite_number}"
archive_path="$work_root/$sqlite_archive"
output_root="$project_root/site/public/sqlite-wasm"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for the pinned SQLite Wasm toolchain" >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo "Docker is installed but its daemon is not running" >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "curl is required to download the pinned SQLite source" >&2
  exit 1
}
command -v unzip >/dev/null 2>&1 || {
  echo "unzip is required to extract the pinned SQLite source" >&2
  exit 1
}

mkdir -p "$work_root" "$output_root"
if [ ! -f "$archive_path" ]; then
  curl --fail --location --output "$archive_path" "$sqlite_url"
fi

actual_sha3=$(node -e 'const fs=require("node:fs");const c=require("node:crypto");const b=fs.readFileSync(process.argv[1]);process.stdout.write(c.createHash("sha3-256").update(b).digest("hex"));' "$archive_path")
if [ "$actual_sha3" != "$sqlite_sha3" ]; then
  echo "SQLite source SHA3-256 mismatch: $actual_sha3" >&2
  exit 1
fi

if [ ! -d "$source_root" ]; then
  unzip -q "$archive_path" -d "$work_root"
fi

docker run --rm \
  --volume "$project_root:/repo" \
  --volume "$work_root:/work" \
  --workdir "/work/sqlite-src-${sqlite_number}" \
  "$emsdk_image" \
  bash -lc '
    set -eu
    apt-get update >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tcl-dev wabt >/dev/null
    ./configure --enable-all >/dev/null
    make -j4 sqlite3.c >/dev/null
    cd ext/wasm
    make clean >/dev/null
    make -j4 \
      b-esm \
      jswasm/sqlite3-worker1.mjs \
      jswasm/sqlite3-worker1-promiser.mjs \
      emcc_opt=-Oz \
      sqlite3_wasm_extra_init.c=/repo/native/sqlite3-wasm-extra-init.c >/dev/null
  '

for artifact in sqlite3.mjs sqlite3.wasm sqlite3-worker1.mjs sqlite3-worker1-promiser.mjs; do
  if [ "$artifact" = "sqlite3.wasm" ]; then
    source="$source_root/ext/wasm/jswasm/esm/$artifact"
  else
    source="$source_root/ext/wasm/jswasm/$artifact"
  fi
  [ -f "$source" ] || {
    echo "SQLite Wasm build did not produce $artifact" >&2
    exit 1
  }
  chmod u+w "$output_root/$artifact" 2>/dev/null || true
  cp "$source" "$output_root/$artifact"
done

node "$project_root/native/write-wasm-manifest.mjs" \
  "$output_root" \
  "$project_root" \
  "$sqlite_version" \
  "$sqlite_url" \
  "$sqlite_sha3" \
  "$emsdk_image"

printf '%s\n' "$output_root"
