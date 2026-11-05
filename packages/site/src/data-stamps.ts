import { DATA_STAMP_SCHEMA, type DataStamps } from "@mark1russell7/site-pages";

/**
 * This value is the SHA-256 of `packing-record.json`. A test compares it with the file.
 * A new record of the script fails that test until the stamp below names its date and its version.
 */
export const RECORD_SHA256 = "b130cd98ecbd8868ccbde114a27b676e046e6b4bca897b81ea0aafd55f3b76ad";

/**
 * These stamps name the record of the response explorer. The script measured one fixed set of placements of one version.
 * The record is a sample for the explorer, so it has no age limit, and the page says why.
 */
export const STAMPS: DataStamps = {
  schema: DATA_STAMP_SCHEMA,
  pages: [
    {
      page: "index.html",
      study: true,
      noLimit: {
        reproduce: "The record measures that version only, so a run of the current packing code measures another version.",
        today: "The record is a sample that shows the explorer, and this page claims nothing about packing today.",
      },
      runs: [
        {
          id: "measure-packing.ts",
          url: "https://github.com/mark1russell7/template/blob/0bd45dc80736d6fa8b95379f8268c3d8981e8d35/packages/site/scripts/measure-packing.ts",
          date: "2026-11-04T16:49:50Z",
          engines: { "@mark1russell7/packing": "0.6.1" },
        },
      ],
    },
  ],
};
