// Whether the Labor Hours Planning local preview (bj-finance #742) is on:
// only on a developer's machine, `next dev` (NODE_ENV "development"; every
// production build is "production") with LOCAL_PREVIEW=1. Its own small
// module, with no Node-only imports, so the middleware's sign-in bypass and
// the preview's page, route and reads all ask the same question.

export function previewEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.LOCAL_PREVIEW === "1";
}
