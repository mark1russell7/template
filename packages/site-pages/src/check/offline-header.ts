/**
 * The header of the home page that the service worker of the offline shell gives in place of a page that it does not keep.
 * The gate `site-pages check --offline` reads it. Thus a page of the check that the worker does not keep fails.
 *
 * This file is in the folder of the check, because the site-pages action starts the check from a sparse checkout of this folder.
 */
export const FALLBACK_HEADER = "x-site-offline";
