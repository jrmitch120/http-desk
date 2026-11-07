// Plain-words explanations of HTTP status codes, for the status pill's tooltip in
// the response viewer. A static table (RFC 9110 plus the common WebDAV and
// extension codes) so it works offline and never depends on the reason phrase a
// server chooses to send.

/** Standard name and a one-line explanation for each listed code. */
const STATUS: Record<number, [name: string, explanation: string]> = {
  100: ["Continue", "the server got the request headers; the client can send the body"],
  101: ["Switching Protocols", "the server is switching to the protocol the client asked for"],
  102: ["Processing", "the server is working on the request but has no response yet"],
  103: ["Early Hints", "headers the client can act on before the final response arrives"],
  200: ["OK", "the request succeeded"],
  201: ["Created", "the request succeeded and created a new resource"],
  202: ["Accepted", "the request was accepted for processing, which hasn't finished"],
  203: ["Non-Authoritative Information", "the request succeeded, but a proxy changed the response"],
  204: ["No Content", "the request succeeded and there is no body to send"],
  205: ["Reset Content", "the request succeeded; the client should reset its form or view"],
  206: ["Partial Content", "the server sent only the requested range of the body"],
  207: ["Multi-Status", "the body holds a separate status for each of several resources"],
  208: ["Already Reported", "these resources were already listed earlier in the response"],
  226: ["IM Used", "the server applied instance manipulations to the resource"],
  300: ["Multiple Choices", "the resource has several representations to choose from"],
  301: ["Moved Permanently", "the resource has a new permanent URL, given in Location"],
  302: ["Found", "the resource is temporarily at the URL given in Location"],
  303: ["See Other", "the result is at the URL given in Location; fetch it with GET"],
  304: ["Not Modified", "the cached copy is still valid, so no body was sent"],
  305: ["Use Proxy", "the resource must be fetched through a proxy (deprecated)"],
  307: ["Temporary Redirect", "the resource is temporarily at Location; repeat the same method there"],
  308: ["Permanent Redirect", "the resource has moved to Location for good; repeat the same method there"],
  400: ["Bad Request", "the server couldn't understand the request because it was malformed"],
  401: ["Unauthorized", "the request needs valid authentication credentials"],
  402: ["Payment Required", "payment is needed before the server will respond"],
  403: ["Forbidden", "the server understood the request but refuses to allow it"],
  404: ["Not Found", "the server has nothing at this URL"],
  405: ["Method Not Allowed", "the resource doesn't support this HTTP method"],
  406: ["Not Acceptable", "the server can't produce a response matching the Accept headers"],
  407: ["Proxy Authentication Required", "the proxy needs valid authentication credentials"],
  408: ["Request Timeout", "the server gave up waiting for the request"],
  409: ["Conflict", "the request conflicts with the current state of the resource"],
  410: ["Gone", "the resource used to exist here and was removed for good"],
  411: ["Length Required", "the server needs a Content-Length header"],
  412: ["Precondition Failed", "a condition in the request headers (e.g. If-Match) wasn't met"],
  413: ["Content Too Large", "the request body is larger than the server will accept"],
  414: ["URI Too Long", "the URL is longer than the server will accept"],
  415: ["Unsupported Media Type", "the server doesn't accept the request body's Content-Type"],
  416: ["Range Not Satisfiable", "the requested range lies outside the resource"],
  417: ["Expectation Failed", "the server can't meet the Expect header"],
  418: ["I'm a teapot", "the server refuses to brew coffee because it is a teapot (a joke code)"],
  421: ["Misdirected Request", "the request went to a server that can't answer for this host"],
  422: ["Unprocessable Content", "the server understood the request but the content was invalid"],
  423: ["Locked", "the resource is locked"],
  424: ["Failed Dependency", "the request failed because an earlier request it depends on failed"],
  425: ["Too Early", "the server won't risk processing a request that might be replayed"],
  426: ["Upgrade Required", "the client must switch to the protocol given in Upgrade"],
  428: ["Precondition Required", "the server needs the request to be conditional (e.g. If-Match)"],
  429: ["Too Many Requests", "the client sent too many requests; slow down (see Retry-After)"],
  431: ["Request Header Fields Too Large", "the request headers are larger than the server will accept"],
  451: ["Unavailable For Legal Reasons", "the resource can't be served for legal reasons"],
  500: ["Internal Server Error", "the server hit an unexpected error"],
  501: ["Not Implemented", "the server doesn't support what the request needs"],
  502: ["Bad Gateway", "a gateway or proxy got an invalid response from the server behind it"],
  503: ["Service Unavailable", "the server is overloaded or down for maintenance; try again later"],
  504: ["Gateway Timeout", "a gateway or proxy timed out waiting for the server behind it"],
  505: ["HTTP Version Not Supported", "the server doesn't support this HTTP version"],
  506: ["Variant Also Negotiates", "the server's content negotiation is misconfigured"],
  507: ["Insufficient Storage", "the server has no room to store what the request needs"],
  508: ["Loop Detected", "the server found an infinite loop while processing the request"],
  510: ["Not Extended", "the request needs further extensions before the server can fulfil it"],
  511: ["Network Authentication Required", "the client must sign in to the network first (e.g. a captive portal)"],
};

/** What a status class means, for codes missing from the table. */
const CLASSES = ["informational", "success", "redirection", "client error", "server error"];

/**
 * A one-line explanation of `status`, e.g. "422 Unprocessable Content: the
 * server understood the request but the content was invalid". A listed code
 * uses its standard name; an unlisted one keeps the server's `reason` phrase (if
 * any) and is explained by its class, e.g. "499 Client Closed Request: 4xx
 * client error".
 */
export function explainStatus(status: number, reason = ""): string {
  const listed = STATUS[status];
  if (listed) return `${status} ${listed[0]}: ${listed[1]}`;
  const head = reason.trim() ? `${status} ${reason.trim()}` : String(status);
  const cls = Math.floor(status / 100);
  return `${head}: ${cls >= 1 && cls <= 5 ? `${cls}xx ${CLASSES[cls - 1]}` : "non-standard status code"}`;
}
