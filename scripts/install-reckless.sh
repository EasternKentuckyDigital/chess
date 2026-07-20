#!/bin/sh
set -eu

source_dir="${1:-../recklesschessweb/dist}"
target_dir="static/vendor/reckless"

for required in reckless-engine.js reckless-worker.js reckless.js SOURCE.md LICENSE; do
  if [ ! -f "$source_dir/$required" ]; then
    echo "Missing $source_dir/$required. Run pnpm run build in recklesschessweb first." >&2
    exit 1
  fi
done

mkdir -p "$target_dir"
cp -R "$source_dir"/. "$target_dir"/

echo "Reckless browser assets installed in $target_dir."
echo "Set browserEngines.reckless.enabled to true in static/config.js before deployment."
