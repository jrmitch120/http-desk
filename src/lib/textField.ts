// Every text field the app draws (<input>, <textarea>) spreads these, so the OS
// never autocompletes, autocorrects, capitalizes or spell-checks what's typed:
// HttpDesk's fields hold paths, names, URLs, numbers and code, not prose. WebKit
// on macOS otherwise offers text-replacement bubbles ("asdasd" → "Asdasd").
// `src/guardrail/text-fields.test.ts` fails on a field without them.
export const textFieldAttrs = {
  autocomplete: "off",
  autocorrect: "off",
  autocapitalize: "off",
  spellcheck: false,
} as const;
