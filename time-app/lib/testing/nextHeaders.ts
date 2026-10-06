// Stands in for next/headers when a route handler runs under node --test (see
// fakeSupabase.ts): the request's cookies are the fake session's.
import { requestCookies } from "./fakeSupabase.ts";

export function cookies() {
  return requestCookies();
}
