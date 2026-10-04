// A content script's own `fetch` is not the page's here; `content.fetch` is.
const page = (globalThis as { content?: { fetch?: typeof fetch } }).content;

/** Requests to the platform are sent the way the page sends its own. */
export const pageFetch: typeof fetch = (input, init) => (page?.fetch ? page.fetch(input, init) : fetch(input, init));
