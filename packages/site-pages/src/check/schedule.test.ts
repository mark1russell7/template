import { describe, expect, it } from "vitest";
import { cronLines, scheduleGapDays } from "./schedule.ts";

describe("cronLines", () => {
  it("gives the number of each line and its text, in each form that a workflow can write", () => {
    const workflow = [
      "on:",
      "  schedule:",
      '    - cron: "1 2 * * *"',
      "    - cron: '3 4 * * *' # weekly",
      "    - cron: 5 6 * * *",
      '    - "cron": "7 8 * * *"',
      "    # - cron: 9 9 * * *",
    ].join("\r\n");
    expect(cronLines(workflow)).toEqual([
      { line: 3, cron: "1 2 * * *" },
      { line: 4, cron: "3 4 * * *" },
      { line: 5, cron: "5 6 * * *" },
      { line: 6, cron: "7 8 * * *" },
    ]);
  });

  it("gives an empty text for a line with no value, so the gate names the line", () => {
    expect(cronLines("    - cron:")).toEqual([{ line: 1, cron: "" }]);
    expect(scheduleGapDays("    - cron:")).toBe("the gate cannot read the line `cron: `");
  });

  it("does not read another key that starts with the same word", () => {
    expect(cronLines("    cronjob: 1 2 * * *\n    # cron: 1 2 * * *")).toEqual([]);
  });
});

describe("scheduleGapDays", () => {
  const workflow = (...lines: readonly string[]): string => `on:\n  schedule:\n${lines.map((line) => `    - cron: "${line}"`).join("\n")}\n`;

  it("gives 1 for a daily schedule", () => {
    expect(scheduleGapDays(workflow("40 5 * * *"))).toBe(1);
  });

  it("gives 7 for a weekly schedule", () => {
    expect(scheduleGapDays(workflow("23 6 * * 1"))).toBe(7);
  });

  it("gives the longest month for a monthly schedule", () => {
    expect(scheduleGapDays(workflow("0 0 1 * *"))).toBe(31);
  });

  it("joins the lines of a workflow", () => {
    expect(scheduleGapDays(workflow("0 0 * * 1", "0 0 * * 4"))).toBe(4);
  });

  it("reads lists, ranges and steps", () => {
    expect(scheduleGapDays(workflow("0 0 * * 1,3,5"))).toBe(3);
    expect(scheduleGapDays(workflow("0 0 * * 1-5"))).toBe(3);
    expect(scheduleGapDays(workflow("0 0 */2 * *"))).toBe(2);
  });

  it("starts on a day that matches one of the two day fields", () => {
    expect(scheduleGapDays(workflow("0 0 1 * 1"))).toBe(7);
  });

  it("gives a text with no schedule and for a comment", () => {
    expect(scheduleGapDays("on:\n  push:\n")).toBe("the workflow has no line `cron:`");
    expect(scheduleGapDays('on:\n  # - cron: "0 0 * * *"\n  push:\n')).toBe("the workflow has no line `cron:`");
  });

  it("names the line of a form that it cannot read", () => {
    expect(scheduleGapDays(workflow("0 0 * * MON"))).toBe("the gate cannot read the line `cron: 0 0 * * MON`");
    expect(scheduleGapDays(workflow("0 0 * *"))).toBe("the gate cannot read the line `cron: 0 0 * *`");
    expect(scheduleGapDays(workflow("0 0 * * 1", "0 0 * * MON"))).toBe("the gate cannot read the line `cron: 0 0 * * MON`");
  });

  it("names the line of a schedule with one start in two years", () => {
    expect(scheduleGapDays(workflow("0 0 29 2 *"))).toBe("the lines `cron: 0 0 29 2 *` give fewer than two starts in two years");
  });
});
