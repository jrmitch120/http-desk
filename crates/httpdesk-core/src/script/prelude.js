// The JetBrains HTTP Client script API, as far as HttpDesk implements it.
//
// Evaluated once per script context, before the user's script, as a function
// the engine (src/script.rs) calls with:
//   host: Rust functions this API is built on (`host.test(name, passed, message)`,
//         `host.log(line)`, `host.setVariable(name, value)`)
//   data: the exchange as plain JSON. A response handler gets { response: { status,
//         headers, body, json, mimeType, charset } }, a pre-request script gets
//         { request: { environment, variables } } (name → value objects); both
//         get limits: { time, memory }.
// It defines the globals the user's script sees and keeps `host` out of reach.
//
// Every JetBrains API that isn't implemented here throws "<api> isn't supported
// in HttpDesk" instead of doing nothing. To implement one, add a Rust function to
// `host` in src/script.rs, call it from here, take its name out of the
// unsupported namespace it falls under, and list it in api.json (next to this
// file), which the Scripts editor completes from. A test (tests/scripts.rs)
// fails until the list names exactly what this file implements.
(function (host, data) {
  "use strict";

  class UnsupportedApiError extends Error {
    constructor(api) {
      super(api + " isn't supported in HttpDesk");
      this.name = "UnsupportedApiError";
    }
  }

  class AssertionError extends Error {
    constructor(message) {
      super(message);
      this.name = "AssertionError";
    }
  }

  // A function that throws for `api` when called.
  const unsupported = (api) =>
    function () {
      throw new UnsupportedApiError(api);
    };

  // An object whose every member is the unsupported API `prefix.member`.
  const unsupportedNamespace = (prefix) =>
    new Proxy(
      {},
      {
        get(_, key) {
          if (typeof key !== "string") return undefined;
          throw new UnsupportedApiError(prefix + "." + key);
        },
      },
    );

  // What a failed test says about the error that failed it.
  function messageOf(e) {
    if (e instanceof Error) {
      if (e.name === "InternalError" && e.message === "out of memory") {
        return "Stopped at " + data.limits.memory + ", the memory limit for a script";
      }
      const plain = e instanceof AssertionError || e instanceof UnsupportedApiError || e.name === "Error";
      return plain ? e.message : e.name + ": " + e.message;
    }
    return String(e);
  }

  // How `client.log` writes a value: text as it is, objects as JSON where they
  // can be, anything else as JavaScript would print it.
  function logText(v) {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null) {
      try {
        return JSON.stringify(v);
      } catch (_) {
        // A cycle or a BigInt inside: fall through to String.
      }
    }
    return String(v);
  }

  let testDepth = 0;

  const client = {
    test(name, fn) {
      name = String(name);
      testDepth++;
      try {
        if (typeof fn !== "function") throw new TypeError("client.test needs a function as its second argument");
        fn();
        host.test(name, true, null);
      } catch (e) {
        host.test(name, false, messageOf(e));
      } finally {
        testDepth--;
      }
    },
    assert(condition, message) {
      const text = message === undefined ? "Assertion failed" : String(message);
      if (testDepth > 0) {
        if (!condition) throw new AssertionError(text);
        return;
      }
      host.test(text, !!condition, condition ? null : text);
    },
    global: unsupportedNamespace("client.global"),
    log(...values) {
      host.log(values.map(logText).join(" "));
    },
    exit: unsupported("client.exit"),
  };

  // The response, for a response handler. A pre-request script has none.
  function responseApi(r) {
    let body = r.body;
    if (r.json) {
      try {
        body = JSON.parse(r.body);
      } catch (_) {
        // Not valid JSON after all: the script sees the text, as in JetBrains.
      }
    }
    const lower = (name) => String(name).toLowerCase();
    return {
      status: r.status,
      body,
      headers: {
        valueOf(name) {
          const found = r.headers.find(([k]) => k.toLowerCase() === lower(name));
          return found ? found[1] : null;
        },
        valuesOf(name) {
          return r.headers.filter(([k]) => k.toLowerCase() === lower(name)).map(([, v]) => v);
        },
      },
      contentType: { mimeType: r.mimeType, charset: r.charset },
    };
  }

  // The request a pre-request script runs before: its variables (for `{{name}}`
  // in this request only) and the selected environment. Every other member is
  // unsupported.
  function requestApi(r) {
    const variables = new Map(Object.entries(r.variables));
    const environment = new Map(Object.entries(r.environment));
    const known = {
      variables: {
        set(name, value) {
          if (Array.isArray(value)) throw new UnsupportedApiError("request.variables.set with an array (iterations)");
          const text = typeof value === "string" ? value : value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
          variables.set(String(name), text);
          host.setVariable(String(name), text);
        },
        get(name) {
          return variables.has(String(name)) ? variables.get(String(name)) : null;
        },
      },
      environment: {
        get(name) {
          return environment.has(String(name)) ? environment.get(String(name)) : null;
        },
      },
    };
    return new Proxy(known, {
      get(target, key) {
        if (typeof key !== "string" || Object.hasOwn(target, key)) return target[key];
        throw new UnsupportedApiError("request." + key);
      },
    });
  }

  globalThis.client = client;
  if (data.response) globalThis.response = responseApi(data.response);
  globalThis.request = data.request ? requestApi(data.request) : unsupportedNamespace("request");
  globalThis.crypto = unsupportedNamespace("crypto");
  globalThis.$random = unsupportedNamespace("$random");
  globalThis.jsonPath = unsupported("jsonPath");
  globalThis.xpath = unsupported("xpath");
});
