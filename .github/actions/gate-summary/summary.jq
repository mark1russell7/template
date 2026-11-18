# Input: toJSON(needs) of a summary job. $changes: the id of the job of the action "changes". $allow: ids that may be skipped.
# $last (optional): for each skipped job of the input "last-result", its last result on the commit, from last.jq, with
# its sha and its check.
# Output: one line for each job, "ok <job>: <why>", "no read <job>: <why>" or "FAIL <job>: <why>", and a last line
# "FAIL" when no job is in needs.
# A job with the output verdict pass, block, no-read or error is a gate of reusable-gate.yml. Its line names the verdict,
# and a success with a verdict that is not pass fails, because the verdict and the result disagree.

($allow | split(" ") | map(select(. != ""))) as $skippable
| ($ARGS.named.last // {}) as $last
| to_entries as $jobs
| (if any($jobs[]; .key == $changes) then ($jobs[] | select(.key == $changes) | .value) else null end) as $c
| ($c != null and $c.result == "success" and $c.outputs.match == "false") as $nomatch
| if ($jobs | length) == 0 then "FAIL needs: the summary job has no job in needs"
  else
    $jobs[]
    | .key as $id | .value.result as $r
    | (.value.outputs.verdict // "") as $v
    | ($v as $word | ["pass", "block", "no-read", "error"] | any(.[]; . == $word)) as $gate
    | if $id == $changes then
        if $r == "success" and (.value.outputs.match == "true" or .value.outputs.match == "false") then "ok \($id): match \(.value.outputs.match)"
        elif $r == "success" then "FAIL \($id): no output match (\(.value.outputs.match // "none"))"
        else "FAIL \($id): \($r)" end
      elif $r == "success" and $gate and $v != "pass" then "FAIL \($id): success, but the verdict is \($v)"
      elif $r == "success" then "ok \($id): success\(if $gate then ", verdict pass" else "" end)"
      elif $r == "skipped" and $nomatch then "ok \($id): skipped, the pull request changes no file of the gate"
      elif $r == "skipped" and ($last | has($id)) then
        $last[$id] as $l
        | (($l.sha // "") | .[0:7]) as $sha
        | if $l.result == "success" then "ok \($id): skipped, and the last result of \"\($l.check)\" on \($sha) passed (run \($l.run))"
          elif $l.result == "none" then "no read \($id): skipped, and \($sha) has no result of \"\($l.check)\""
          elif $l.result == "error" then "FAIL \($id): skipped, and the check runs of \($sha) cannot be read: \($l.why // "no reason")"
          else "FAIL \($id): skipped, and the last result of \"\($l.check)\" on \($sha) is \($l.result) (run \($l.run))" end
      elif $r == "skipped" and ($skippable | index($id)) then "ok \($id): skipped, allow-skip names it"
      else "FAIL \($id): \($r)\(if $gate and $v != "pass" then ", verdict \($v)" else "" end)" end
  end
