# The function before_deadline starts a command with the time that is left to the deadline DEADLINE (epoch seconds).
# The action coverage and the job coverage of reusable-ci.yml use it. Thus a slow step stops before the limit of the
# job, and the step fails. A job that reaches its limit gets the result "cancelled", also with continue-on-error.
# Exit code 124: the command did not start, or it stopped at the deadline. Without DEADLINE, the command has no limit.
# DEADLINE_LEVEL (error or warning, default error) is the level of the annotation of a stop.
before_deadline() {
  if [ -z "${DEADLINE:-}" ]; then
    "$@"
    return
  fi
  local left
  left=$((DEADLINE - $(date +%s)))
  if [ "$left" -le 0 ]; then
    echo "::${DEADLINE_LEVEL:-error}::$1 did not start: the deadline of the coverage job is past."
    return 124
  fi
  # GNU timeout: Linux and Git Bash on Windows have it. macOS has it as gtimeout only when coreutils is installed.
  local runner=""
  if timeout --version > /dev/null 2>&1; then
    runner=timeout
  elif gtimeout --version > /dev/null 2>&1; then
    runner=gtimeout
  else
    echo "::warning::This runner has no GNU timeout, so $1 has no deadline. Only the limit of the job stops it."
    "$@"
    return
  fi
  # A child process that ignores TERM (a pnpm or tsc child) gets KILL 10 seconds later
  local code=0
  "$runner" --kill-after=10s "$left" "$@" || code=$?
  if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
    echo "::${DEADLINE_LEVEL:-error}::$* stopped at the deadline of the coverage job."
    return 124
  fi
  return "$code"
}
