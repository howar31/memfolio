/** Requests to the platform are sent the way the page sends its own. */
export const pageFetch: typeof fetch = (input, init) => fetch(input, init);
