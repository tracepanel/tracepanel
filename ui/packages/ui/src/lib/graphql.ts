// A GraphQL request's name, from the body it sends: "GraphQL query Books", as its server's trace names it. The widget
// names a request so while it runs and keeps the name once it answers; the agent names a stored request's trace so
// when its server didn't (an answer before the operation ran, a 503). One rule, its cases in schema/graphql-names.json.
// Plain data, no DOM.

const OPERATION = /^\s*(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/;

/** The largest body read for its operation. */
const MAX_BODY = 100_000;

type GraphqlBody = { query?: unknown; operationName?: unknown };

/** A JSON body small enough to read, with a query in it. */
function maybeGraphql(body: unknown): body is string {
  return typeof body === "string" && body.length <= MAX_BODY && body.includes('"query"');
}

/** A request's body as GraphQL sends it (`{"query": …, "operationName": …}`); empty for any other. */
function graphqlBody(body: unknown): GraphqlBody {
  if (!maybeGraphql(body)) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as GraphqlBody) : {};
  } catch {
    return {};
  }
}

/** "GraphQL query Books": a named operation's request, by its type and the name the client sent (else its own). */
export function graphqlName(body: unknown): string | undefined {
  const parsed = graphqlBody(body);
  const match = OPERATION.exec(typeof parsed.query === "string" ? parsed.query : "");
  if (!match) return undefined;
  const name = typeof parsed.operationName === "string" && parsed.operationName ? parsed.operationName : match[2];
  return `GraphQL ${match[1]} ${name}`;
}

/** Whether a name is a GraphQL operation's, as graphqlName (and the agent) write it. */
export function namesOperation(name: string | undefined): boolean {
  return name?.startsWith("GraphQL ") === true;
}

/** An attribute's text, when it has one. */
function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * "GraphQL query Authors": the operation a call to a GraphQL server carries, as the agent names a request by it
 * (graphql.rs): its SDK's attributes (`graphql.operation.type` and `.name`, else `graphql.operation`), else the body it
 * sent. None for any other call. One URL serves every operation: the operation says which call it was.
 */
export function callOperation(attrs: Readonly<Record<string, unknown>>): string | undefined {
  const kind = textOf(attrs["graphql.operation.type"]);
  const name = textOf(attrs["graphql.operation.name"]);
  if (kind && name) return `GraphQL ${kind} ${name}`;
  const label = textOf(attrs["graphql.operation"]);
  if (label) return `GraphQL ${label}`;
  return graphqlName(attrs["http.request.body"]);
}
