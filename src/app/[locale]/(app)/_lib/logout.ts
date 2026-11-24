/**
 * BUG-001 — log out, then leave the workspace for the login page.
 *
 * A FULL navigation, not a client-side `router.push`: the client still holds
 * the signed-in world (the session query, the router's cache of pages rendered
 * for a signed-in user), and a client-side push could land on one of those. A
 * reload starts from the server, which now sees no session.
 *
 * A FAILED request is said, not swallowed. better-auth's sign-out answers 200
 * even without a session, so an error here means the request did not get
 * through: the network, a browser extension that wraps `fetch`, a 5xx. Before,
 * the rejection went unhandled, the navigation never ran and the screen simply
 * stayed as it was.
 *
 * The effects are injected so the order and the failure path are unit-tested
 * without a browser.
 */
export interface LogOutDeps {
  /** `authClient.signOut` — resolves `{ error }`, or rejects on a network failure. */
  readonly signOut: () => Promise<{ error: unknown }>;
  /** Leave for `url` with a full page load. */
  readonly navigate: (url: string) => void;
  /** Tell the user the sign-out did not go through. */
  readonly onFailure: () => void;
  /** The login page in the current UI language. */
  readonly loginUrl: string;
}

/** Sign out; `true` when the user is on the way to the login page. */
export async function logOut(deps: LogOutDeps): Promise<boolean> {
  let ok: boolean;
  try {
    const { error } = await deps.signOut();
    ok = !error;
  } catch {
    ok = false;
  }
  if (!ok) {
    deps.onFailure();
    return false;
  }
  deps.navigate(deps.loginUrl);
  return true;
}
