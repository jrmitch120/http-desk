// GraphQL highlighting for `.http` bodies (a request with `X-REQUEST-TYPE: GraphQL`,
// a GRAPHQL method or a graphql Content-Type): a small stream tokenizer, enough to
// tell keywords, fields, types, variables, strings and numbers apart. The JSON
// variables written after the query read as strings and numbers.
import { StreamLanguage, type StringStream } from "@codemirror/language";

const KEYWORDS = new Set([
  "query", "mutation", "subscription", "fragment", "on", "schema", "type", "input", "enum",
  "interface", "union", "scalar", "extend", "directive", "implements", "repeatable",
]);
const ATOMS = new Set(["true", "false", "null"]);

function token(stream: StringStream): string | null {
  if (stream.eatSpace()) return null;
  if (stream.eat("#")) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.match('"""')) {
    if (!stream.skipTo('"""')) stream.skipToEnd();
    else stream.match('"""');
    return "string";
  }
  if (stream.eat('"')) {
    let escaped = false;
    for (let c = stream.next(); c !== undefined; c = stream.next()) {
      if (c === '"' && !escaped) break;
      escaped = !escaped && c === "\\";
    }
    return "string";
  }
  if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";
  if (stream.match(/^\$[_A-Za-z][_0-9A-Za-z]*/)) return "variableName";
  if (stream.match(/^@[_A-Za-z][_0-9A-Za-z]*/)) return "meta";
  const word = stream.match(/^[_A-Za-z][_0-9A-Za-z]*/) as RegExpMatchArray | null;
  if (word) {
    const w = word[0];
    if (KEYWORDS.has(w)) return "keyword";
    if (ATOMS.has(w)) return "atom";
    return /^[A-Z]/.test(w) ? "typeName" : "propertyName";
  }
  if (stream.match("...")) return "punctuation";
  const c = stream.next()!;
  return "{}()[]".includes(c) ? "bracket" : "punctuation";
}

export const graphqlLanguage = StreamLanguage.define({ name: "graphql", token, languageData: { commentTokens: { line: "#" } } });
