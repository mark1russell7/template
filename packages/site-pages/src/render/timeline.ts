/**
 * The layout of the release timeline: one mark for each version on a time axis.
 *
 * @remarks The axis has one band for each day with a release. A run of days without a release
 * becomes one narrow band, so the busy days get the width. In a day band, the time is linear. Marks
 * that are near each other go into lanes, so that no two labels overlap.
 */

import { compareVersions } from "../data/versions.ts";
import type { ReleaseKind } from "../data/types.ts";
import { DAY_MS, dayRange, utcDay } from "./dates.ts";

/** What the timeline needs of a version. */
export interface ReleasePoint {
  version: string;
  date: string;
  kind: ReleaseKind;
}

/** The numbers of the lead line of the releases page. */
export interface ReleaseSummary {
  versions: number;
  major: number;
  minor: number;
  patch: number;
  /** The date of the oldest and of the newest version, or null without a release. */
  first: string | null;
  last: string | null;
}

/** This function counts the versions and the kinds. The first release counts as a version only. */
export function releaseSummary(releases: readonly ReleasePoint[]): ReleaseSummary {
  const times = releases.map((release) => Date.parse(release.date)).filter(Number.isFinite);
  const count = (kind: ReleaseKind): number => releases.filter((release) => release.kind === kind).length;
  return {
    versions: releases.length,
    major: count("major"),
    minor: count("minor"),
    patch: count("patch"),
    first: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
    last: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
  };
}

/** This function sorts the versions from the oldest to the newest: the sequence of the marks and of the arrow keys. */
export function oldestFirst<T extends ReleasePoint>(releases: readonly T[]): T[] {
  return [...releases].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || compareVersions(a.version, b.version));
}

/** The options of the layout. */
export interface TimelineOptions {
  /** The width of the SVG, in pixels. */
  width: number;
  /** The space at each side, for the labels of the first and the last mark. */
  padX?: number;
  laneHeight?: number;
  /** The width of one character of a label (12 px monospace). */
  charWidth?: number;
  /** The minimum space between two labels in one lane. */
  gap?: number;
  /** The width of a run of days without a release, as a part of the width of a day with releases. */
  emptyWeight?: number;
}

/** A band of the axis: one day with releases, or a run of days with none. */
export interface TimelineBand {
  start: number;
  /** The end of the band: the start of the next day. */
  end: number;
  x0: number;
  x1: number;
  label: string;
  count: number;
  empty: boolean;
}

/** One mark of the timeline. */
export interface TimelineMark<T extends ReleasePoint = ReleasePoint> {
  release: T;
  time: number;
  x: number;
  /** The lane of the mark: 0 is the lane next to the axis. */
  lane: number;
  /** The half width of the label and of the target of the pointer. */
  half: number;
}

/** The layout of the timeline at one width. */
export interface TimelineLayout<T extends ReleasePoint = ReleasePoint> {
  width: number;
  height: number;
  plotTop: number;
  /** The y of the axis line. */
  plotBottom: number;
  laneHeight: number;
  lanes: number;
  bands: TimelineBand[];
  /** The marks from the oldest to the newest. */
  marks: Array<TimelineMark<T>>;
}

/** The top margin of the plot. */
export const PLOT_TOP = 6;
/** The height of the axis labels under the plot. */
export const AXIS_HEIGHT = 46;

/** This function gives the y of the center line of a lane. */
export function laneCenter(layout: { plotBottom: number; laneHeight: number }, lane: number): number {
  return layout.plotBottom - (lane + 0.5) * layout.laneHeight;
}

/** This function calculates the layout of the timeline at a width. */
export function timelineLayout<T extends ReleasePoint>(releases: readonly T[], options: TimelineOptions): TimelineLayout<T> {
  const { width, padX = 30, laneHeight = 38, charWidth = 7.4, gap = 8, emptyWeight = 0.6 } = options;
  const ordered = oldestFirst(releases).filter((release) => Number.isFinite(Date.parse(release.date)));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) {
    return { width, height: PLOT_TOP + laneHeight + AXIS_HEIGHT, plotTop: PLOT_TOP, plotBottom: PLOT_TOP + laneHeight, laneHeight, lanes: 0, bands: [], marks: [] };
  }

  // The bands: each day with releases, and each run of days without
  const counts = new Map<number, number>();
  for (const release of ordered) {
    const day = utcDay(Date.parse(release.date));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const raw: Array<{ start: number; end: number; count: number; empty: boolean; weight: number }> = [];
  for (let day = utcDay(Date.parse(first.date)); day <= utcDay(Date.parse(last.date)); day += DAY_MS) {
    const count = counts.get(day) ?? 0;
    const previous = raw[raw.length - 1];
    if (count === 0 && previous?.empty) previous.end = day + DAY_MS;
    else raw.push({ start: day, end: day + DAY_MS, count, empty: count === 0, weight: count === 0 ? emptyWeight : 1 });
  }
  const unit = (width - 2 * padX) / raw.reduce((sum, band) => sum + band.weight, 0);
  let cursor = padX;
  const bands: TimelineBand[] = raw.map((band) => {
    const x0 = cursor;
    cursor += band.weight * unit;
    return { start: band.start, end: band.end, x0, x1: cursor, label: dayRange(band.start, band.end - 1), count: band.count, empty: band.empty };
  });
  const xOf = (time: number): number => {
    const band = bands.find((candidate) => time >= candidate.start && time < candidate.end) ?? bands[bands.length - 1];
    if (!band) return padX;
    return band.x0 + ((time - band.start) / (band.end - band.start)) * (band.x1 - band.x0);
  };

  // The lanes: each mark goes into the lowest lane where its label does not touch the last label
  const laneEnds: number[] = [];
  const marks: Array<TimelineMark<T>> = ordered.map((release) => {
    const time = Date.parse(release.date);
    const x = xOf(time);
    const half = Math.max(release.version.length * charWidth, 24) / 2;
    let lane = laneEnds.findIndex((end) => end + gap <= x - half);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = x + half;
    return { release, time, x, lane, half };
  });

  const lanes = laneEnds.length;
  const plotBottom = PLOT_TOP + lanes * laneHeight;
  return { width, height: plotBottom + AXIS_HEIGHT, plotTop: PLOT_TOP, plotBottom, laneHeight, lanes, bands, marks };
}
