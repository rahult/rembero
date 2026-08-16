#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$project_root/build"
source_file="$project_root/native/rembero.c"
mkdir -p "$output_dir"

case "$(uname -s)" in
  Darwin)
    sdk_path=$(xcrun --show-sdk-path)
    output="$output_dir/rembero.dylib"
    cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -dynamiclib -undefined dynamic_lookup \
      -I"$sdk_path/usr/include" "$source_file" -o "$output"
    ;;
  Linux)
    output="$output_dir/rembero.so"
    sqlite_cflags=$(pkg-config --cflags sqlite3 2>/dev/null || true)
    # sqlite3ext.h is provided by libsqlite3-dev/sqlite-devel.
    # shellcheck disable=SC2086
    cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared $sqlite_cflags \
      "$source_file" -o "$output"
    ;;
  *)
    echo "unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

printf '%s\n' "$output"
