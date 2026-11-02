# Input: toJSON(needs) of a summary job. $changes: the id of the job of the action "changes". $allow: ids that may be skipped.
# Output: one line for each job, "ok <job>: <why>" or "FAIL <job>: <why>", and a last line "FAIL" when no job is in needs.

($allow | split(" ") | map(select(. != ""))) as $skippable
| to_entries as $jobs
| (if any($jobs[]; .key == $changes) then ($jobs[] | select(.key == $changes) | .value) else null end) as $c
| ($c != null and $c.result == "success" and $c.outputs.match == "false") as $nomatch
| if ($jobs | length) == 0 then "FAIL needs: the summary job has no job in needs"
  else
    $jobs[]
    | .key as $id | .value.result as $r
    | if $id == $changes then
        if $r == "success" and (.value.outputs.match == "true" or .value.outputs.match == "false") then "ok \($id): match \(.value.outputs.match)"
        elif $r == "success" then "FAIL \($id): no output match (\(.value.outputs.match // "none"))"
        else "FAIL \($id): \($r)" end
      elif $r == "success" then "ok \($id): success"
      elif $r == "skipped" and $nomatch then "ok \($id): skipped, the pull request changes no file of the gate"
      elif $r == "skipped" and ($skippable | index($id)) then "ok \($id): skipped, allow-skip names it"
      else "FAIL \($id): \($r)" end
  end
