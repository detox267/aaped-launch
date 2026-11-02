#!/usr/bin/env bash
set -euo pipefail
umask 077
task_config="${1:?Provide an absolute private configuration file}"
task_root="$(cd "$(dirname "$0")" && pwd)"
task_lock="$(node -e 'const c=require(process.argv[1]).configFile(process.argv[2]); process.stdout.write(c.journalFile+".lock");' "$task_root/run.cjs" "$task_config")"
exec 9>"$task_lock"
flock --nonblock 9 || { echo 'A Fusion collector already holds this journal lock.' >&2; exit 1; }
exec node "$task_root/run.cjs" "$task_config" --run
