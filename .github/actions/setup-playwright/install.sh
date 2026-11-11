#!/usr/bin/env bash
# The install step of the action setup-playwright. It installs the browsers first and their system packages
# second. Each install has ATTEMPTS tries, and each try has a time limit of MINUTES.
#
# The environment:
#   COMMAND     The command of the Playwright CLI, for example "npx --no-install playwright".
#   BROWSERS    The browsers, separated by spaces.
#   HIT         "true" when the browsers came from the cache.
#   MINUTES     The time limit of each try.
#   ATTEMPTS    The number of tries of each install.
#   PACKAGES    "required": a failure of the system packages fails the step.
#               "best-effort": when the system packages fail and each browser starts, the step warns and passes.
#
# The script writes the output "packages" ("installed" or "missing") to GITHUB_OUTPUT.
set -uo pipefail

# The time limit of the probe of the package mirror, and of the start of each browser, in seconds
PROBE_SECONDS=90
START_SECONDS=120

case "${PACKAGES:-}" in
  required | best-effort) ;;
  *)
    echo "::error::The input packages is \"${PACKAGES:-}\". Give \"required\" or \"best-effort\"."
    exit 1
    ;;
esac

# Runs a command with a time limit in seconds, and gives its exit code. setsid (util-linux) gives the command its
# own process group, so the watchdog stops the whole group. The macOS runners and Git Bash on Windows have no
# setsid: there the watchdog stops the process only.
limited() {
  local seconds=$1 pid target watch code
  shift
  if command -v setsid > /dev/null 2>&1; then
    setsid -w "$@" &
    pid=$!
    target="-$pid"
  else
    "$@" &
    pid=$!
    target="$pid"
  fi
  # The watchdog sleeps 1 second at a time and ends when the command ends, so that no long sleep stays after the
  # command (Git Bash on Windows has no pkill to stop it). Its output goes to /dev/null, so that it holds no pipe of
  # the step open.
  (
    for _ in $(seq 1 "$seconds"); do
      kill -0 "$pid" 2> /dev/null || exit 0
      sleep 1
    done
    kill -TERM -- "$target" 2> /dev/null
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2> /dev/null || exit 0
      sleep 1
    done
    kill -KILL -- "$target" 2> /dev/null
  ) > /dev/null 2>&1 &
  watch=$!
  wait "$pid"
  code=$?
  kill "$watch" 2> /dev/null || true
  return "$code"
}

# A stopped try can leave sudo apt-get running in its own session, with the dpkg lock. Stop it and repair dpkg
# before the next try. The wait of 5 seconds comes only after a signal.
clean_up() {
  [ "$RUNNER_OS" = Linux ] || return 0
  local stopped=0
  sudo pkill -TERM -x apt-get 2> /dev/null && stopped=1
  sudo pkill -TERM -x dpkg 2> /dev/null && stopped=1
  if [ "$stopped" = 1 ]; then
    sleep 5
    sudo pkill -KILL -x apt-get 2> /dev/null || true
  fi
  sudo dpkg --configure -a || true
}

# Runs "playwright <step>" ATTEMPTS times at most, and stops at the first try that passes.
tries() {
  local step=$1 attempt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    # $COMMAND and $step have no quotes: the shell splits them into words.
    # shellcheck disable=SC2086
    if limited "$((MINUTES * 60))" $COMMAND $step; then return 0; fi
    echo "::warning::Try $attempt of $ATTEMPTS of \"playwright $step\" failed or took more than $MINUTES minutes."
    clean_up
  done
  return 1
}

# Probes the package mirror. By default apt-get update ignores a transient failure (for example a host name that
# does not resolve), uses the old lists and exits 0. The error mode "any" (apt-get --error-on=any, in apt 2.x)
# makes each failure fail the update. The probe has no retries, and a short limit for each request.
probe() {
  sudo timeout -k 10 "$PROBE_SECONDS" apt-get update -q \
    -o APT::Update::Error-Mode=any \
    -o Acquire::Retries=0 \
    -o Acquire::http::Timeout=20 \
    -o Acquire::https::Timeout=20
}

# Starts each browser with no system packages from this step: a screenshot of about:blank. The screenshot command
# of the Playwright CLI exits with 1 when the browser does not start.
starts() {
  local name file code=0
  local -a args
  for name in $BROWSERS; do
    case "$name" in
      ffmpeg) continue ;;
      chromium | chromium-headless-shell) args=(--browser chromium) ;;
      firefox*) args=(--browser firefox) ;;
      webkit*) args=(--browser webkit) ;;
      # A branded browser or a different build of Chromium, for example chrome, msedge or chromium-tip-of-tree
      *) args=(--browser chromium --channel "$name") ;;
    esac
    file="$RUNNER_TEMP/setup-playwright-start-$name.png"
    rm -f "$file"
    # shellcheck disable=SC2086
    if limited "$START_SECONDS" $COMMAND screenshot "${args[@]}" --timeout 60000 about:blank "$file" && [ -s "$file" ]; then
      echo "$name starts."
    else
      echo "::error::$name does not start (\"playwright screenshot ${args[*]} about:blank\" failed or took more than $START_SECONDS seconds)."
      code=1
    fi
    rm -f "$file"
  done
  return "$code"
}

if [ "${HIT:-}" = true ]; then
  echo "The browsers came from the cache."
elif ! tries "install $BROWSERS"; then
  echo "::error::\"playwright install $BROWSERS\" failed $ATTEMPTS times."
  exit 1
fi

# With the browsers from the cache, apt finds the system packages in the cache too, if an earlier run saved them.
cause=""
if [ "$PACKAGES" = best-effort ] && [ "$RUNNER_OS" = Linux ]; then
  echo "::group::Probe of the package mirror (apt-get update, at most $PROBE_SECONDS seconds)"
  if ! probe; then
    cause="the package mirror did not answer (apt-get update failed or took more than $PROBE_SECONDS seconds)"
    clean_up
  fi
  echo "::endgroup::"
fi
if [ -z "$cause" ] && ! tries "install-deps $BROWSERS"; then
  cause="\"playwright install-deps $BROWSERS\" failed $ATTEMPTS times"
fi

packages=installed
if [ -n "$cause" ]; then
  if [ "$PACKAGES" = required ]; then
    echo "::error::$cause."
    exit 1
  fi
  if ! starts; then
    echo "::error::The system packages are not installed ($cause), and a browser does not start."
    exit 1
  fi
  echo "::warning::The system packages of the browsers are not installed: $cause. Each browser starts, but fonts and other system packages can be missing."
  packages=missing
fi
echo "packages=$packages" >> "$GITHUB_OUTPUT"
