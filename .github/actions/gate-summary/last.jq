# Input: the check runs of a commit, as one array of all the pages. $check: the check name of a job.
# A job of a matrix has one check for each entry, "<check> <entry>" or "<check> (<entry>)". The summary "<check> OK" is not
# an entry.
# Output: the last result of the check on the commit, {result, run, at, checks}, or {result: "none"}.
# A skip, a cancel and a neutral end decide nothing, so the read goes back to the last run that decided.
[ .[]
  | select(.name == $check or ((.name | startswith($check + " ")) and .name != ($check + " OK")))
  | select(.status == "completed" and (.conclusion | IN("success", "failure", "timed_out", "action_required", "startup_failure")))
  | . + { run: ([(.details_url // "") | match("/runs/([0-9]+)") | .captures[0].string] | first // "unknown") }
]
| if length == 0 then { result: "none" }
  else
    group_by(.run)
    | map({
        run: .[0].run,
        at: (map(.completed_at) | max),
        checks: length,
        result: ([.[] | select(.conclusion != "success") | .conclusion] | first // "success")
      })
    | max_by(.at)
  end
