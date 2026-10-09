/**
 * Read-level heuristic for GET links with side effects (logout, delete, unsubscribe, ...). Pure: the page hands over the
 * resolved link URL and its accessible texts, this decides whether following the link looks harmful.
 *
 * Matching is by whole word, never by substring: URL path segments, query keys (and the values of action-like keys such as
 * `action=delete`) and short link labels are split into lowercase, accent-free words (camelCase, `-`, `_`, `.` and spaces
 * separate words), and a deny term must equal one word or a run of consecutive words. So `/logout`, `/users/42/delete`,
 * `/sign-out`, `/cerrar-sesion`, `?action=remove` and a link labelled "Cerrar sesión" are blocked, while `/deleted-items`,
 * `/removal-policy` and `?q=delete` are not.
 *
 * Judgment calls, kept low-false-positive on purpose: the destructive verbs (delete, remove, ...) only count in short words
 * lists (a path segment of at most 3 words, a label of at most 5), because `/blog/how-to-remove-stains` or a card link whose
 * text is a paragraph is prose, not an action; the unmistakable ones (logout, sign out, unsubscribe, cerrar sesión, ...) count
 * in any path segment and in labels of up to 8 words. A docs page such as `/delete-account-help` is blocked as a known
 * false positive. A redirect (`/go?to=...`), a JavaScript handler or an innocent-looking URL cannot be detected.
 */

/** Unmistakable account/session actions. */
const STRICT = new Set([
  "logout", "signout", "logoff", "signoff", "unsubscribe", "cerrarsesion", "darsedebaja", "dardebaja", "desuscribir", "desuscribirse", "unfollow", "unregister",
]);
/** Destructive verbs: only in short word lists. */
const VERBS = new Set(["delete", "remove", "destroy", "eliminar", "borrar", "quitar", "revoke", "deactivate", "desactivar", "desconectar", "salir"]);
/** "Remove filter", "Quitar filtros": clearing a filter is a view change, not a deletion. */
const FILTER = new Set(["filter", "filters", "filtro", "filtros"]);
/** `cancel subscription`, `cancelar suscripcion`, ... */
const CANCEL = new Set(["cancel", "cancelar"]);
const SUBSCRIPTION = new Set(["subscription", "subscriptions", "suscripcion", "suscripciones", "membership", "membresia"]);
/** Query keys whose VALUE names an action. */
const ACTION_KEYS = new Set(["action", "act", "do", "op", "operation", "cmd", "command", "task", "method", "mode", "func", "function"]);

const PATH_VERB_MAX_WORDS = 3;
const LABEL_VERB_MAX_WORDS = 5;
const LABEL_STRICT_MAX_WORDS = 8;
const VALUE_MAX_WORDS = 4;
const MAX_LABELS = 6;
const MAX_LABEL_CHARS = 200;

/** Lowercase, accent-free words of `text` (camelCase and every non-alphanumeric character separate words). */
export function wordsOf(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The deny term found in `words` (the words of one segment, key, value or label), or undefined. */
function termIn(words: string[], maxVerbWords: number): string | undefined {
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const joined = words.slice(i, i + n).join("");
      if (STRICT.has(joined)) return joined;
    }
  }
  // "cerrar la sesion", "cerrar sesion" with a short article in between.
  const cerrar = words.indexOf("cerrar");
  if (cerrar >= 0 && words.slice(cerrar + 1, cerrar + 4).includes("sesion")) return "cerrar sesion";
  if (words.length > maxVerbWords) return undefined;
  if (words.some((w) => FILTER.has(w))) return undefined;
  for (const w of words) if (VERBS.has(w)) return w;
  if (words.some((w) => w === "close" || w === "cerrar") && words.some((w) => w === "account" || w === "cuenta")) return "close account";
  const at = words.findIndex((w) => CANCEL.has(w));
  if (at >= 0 && words.slice(at + 1, at + 4).some((w) => SUBSCRIPTION.has(w))) return "cancel subscription";
  return undefined;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Why following this link at the read level looks like a side effect, or null. `href` is the resolved absolute URL;
 * `labels` are the link's accessible texts (aria-label, title, visible text, image alt).
 */
export function sideEffectLinkReason(href: string, labels: readonly string[] = []): string | null {
  const hit = (where: string, term: string): string =>
    `the link looks like a side-effect link (${where} "${term}"): following it could log you out or change data, so it needs --actions interact`;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter((seg) => seg !== "").map((seg) => wordsOf(decode(seg)));
  for (const [at, words] of segments.entries()) {
    // A pair of neighbouring segments reads as one phrase: /account/close, /cuenta/cerrar.
    const term = termIn(words, PATH_VERB_MAX_WORDS) ?? (at > 0 ? termIn([...segments[at - 1]!, ...words], PATH_VERB_MAX_WORDS) : undefined);
    if (term) return hit("path", term);
  }
  for (const [key, value] of url.searchParams) {
    // Rails/Laravel method override: ?_method=delete turns a GET link into a DELETE.
    if (key.toLowerCase() === "_method" && /^(?:delete|put|patch|post)$/i.test(value.trim())) return hit("query _method=", value.trim().toLowerCase());
    const kTerm = termIn(wordsOf(key), PATH_VERB_MAX_WORDS);
    if (kTerm) return hit("query key", kTerm);
    if (ACTION_KEYS.has(key.toLowerCase())) {
      const vWords = wordsOf(value);
      const vTerm = vWords.length <= VALUE_MAX_WORDS ? termIn(vWords, VALUE_MAX_WORDS) : undefined;
      if (vTerm) return hit(`query ${key.toLowerCase()}=`, vTerm);
    }
  }
  for (const label of labels.slice(0, MAX_LABELS)) {
    const words = wordsOf(label.slice(0, MAX_LABEL_CHARS));
    if (words.length === 0 || words.length > LABEL_STRICT_MAX_WORDS) continue;
    const term = termIn(words, LABEL_VERB_MAX_WORDS);
    if (term) return hit("link text", term);
  }
  return null;
}
