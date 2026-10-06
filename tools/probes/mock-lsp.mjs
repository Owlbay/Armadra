#!/usr/bin/env node
// A minimal, deliberately unhelpful language server, for testing the proxy —
// language service design §5.
//
// It exists so the tests can reach the branches a real server reaches only by
// accident: crashing after N messages, never answering, and returning a body
// past the message ceiling. Everything it does answer is the smallest thing
// that is still a valid LSP response.
//
//   node tools/probes/mock-lsp.mjs [--crash-after=N] [--hang] [--big-response]
//
//   --version           print a version banner and exit 0 (the discovery probe)
//   --crash-after=N     exit(9) after handling N messages
//   --hang              accept `textDocument/hover` and never answer it
//   --big-response      answer `textDocument/hover` with ~1 MiB of text
//   --apply-edit        after a didOpen, ask the client to apply a
//                       `WorkspaceEdit` of its own accord, and republish the
//                       answer as a diagnostic so a test can read it — the
//                       proxy forwards diagnostics and forwards nothing else
//                       a server says about itself
//   --apply-outside     the same, but naming a file outside the workspace
//
// Load shaping, for `language-load.mjs` (E3-9): sizes modelled on what a
// TypeScript server answers, so the proxy carries frames of a realistic size.
// Without them every answer stays the smallest valid one.
//
//   --completion-items=N  a completion not after `.` answers N items
//   --member-items=N      a completion right after `.` answers N items
//   --hover-bytes=N       hover answers ~N bytes of Markdown
//   --diagnostics=N       every publish carries N more diagnostics
//
// It reads `Content-Length` frames on stdin and writes them on stdout, and it
// prints nothing else to stdout — a stray line there would desynchronise the
// framing, which is exactly the failure this file must not have.

import { stdin, stdout, stderr, argv, exit } from "node:process";

const flags = new Set(argv.slice(2).filter((value) => !value.includes("=")));
const options = new Map(
  argv
    .slice(2)
    .filter((value) => value.includes("="))
    .map((value) => {
      const [name, rest] = value.split("=", 2);
      return [name, rest];
    }),
);

if (flags.has("--version")) {
  stdout.write("mock-lsp 0.1.0\n");
  exit(0);
}

const crashAfter = Number(options.get("--crash-after") ?? 0);
const hang = flags.has("--hang");
const bigResponse = flags.has("--big-response");
const applyEdit = flags.has("--apply-edit") || flags.has("--apply-outside");
const applyOutside = flags.has("--apply-outside");
const completionItems = Number(options.get("--completion-items") ?? 0);
const memberItems = Number(options.get("--member-items") ?? 0);
const hoverBytes = Number(options.get("--hover-bytes") ?? 0);
const extraDiagnostics = Number(options.get("--diagnostics") ?? 0);
/**
 * Answer `initialize` with an error and stay up, the way a real server does
 * when it cannot serve this project — `typescript-language-server` with no
 * TypeScript installed says exactly this.
 */
const refuseInitialize = flags.has("--refuse-initialize");

/** The id of the one edit this server ever asks for. */
const APPLY_ID = "mock-apply";

let handled = 0;
let buffer = Buffer.alloc(0);
/** uri -> text, so diagnostics can be recomputed on every change. */
const documents = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  stdout.write(body);
}

function diagnosticsFor(uri, text) {
  // One diagnostic per line containing TODO. Enough to prove that push
  // diagnostics arrive, are recomputed on change, and carry a uri that the
  // proxy has to rewrite on the way out.
  const diagnostics = [];
  text.split("\n").forEach((line, index) => {
    const column = line.indexOf("TODO");
    if (column < 0) return;
    diagnostics.push({
      range: {
        start: { line: index, character: column },
        end: { line: index, character: column + 4 },
      },
      severity: 2,
      source: "mock-lsp",
      message: "TODO left in the file",
    });
  });
  for (let index = 0; index < extraDiagnostics; index += 1) {
    diagnostics.push({
      range: {
        start: { line: index, character: 2 },
        end: { line: index, character: 14 },
      },
      severity: index % 3 === 0 ? 1 : 2,
      code: 2300 + (index % 50),
      source: "mock-lsp",
      message: `Property 'value${index}' does not exist on type 'Options'. Did you mean 'values'?`,
    });
  }
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

/**
 * The server asking the client to write files (`workspace/applyEdit`).
 *
 * Nothing prompted it: that is the point. A code action can produce one, and
 * so can a server that simply decides the buffer should look different, and
 * the proxy has to answer the same way in both cases.
 */
let appliedTo = null;
function requestApplyEdit(uri) {
  appliedTo = uri;
  const target = applyOutside ? "file:///etc/elsewhere.txt" : uri;
  send({
    jsonrpc: "2.0",
    id: APPLY_ID,
    method: "workspace/applyEdit",
    params: {
      label: "mock rewrite",
      edit: {
        changes: {
          [target]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 4 },
              },
              newText: "DONE",
            },
          ],
        },
      },
    },
  });
}

/**
 * The client's answer, republished as a diagnostic.
 *
 * The proxy forwards `publishDiagnostics` and drops everything else a server
 * says about itself, so this is the one channel a test can read the outcome
 * on without the mock inventing a private protocol.
 */
function reportApplyEdit(result) {
  if (!appliedTo) return;
  const applied = result?.applied === true;
  const reason = result?.failureReason ?? "";
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: appliedTo,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity: 3,
          source: "mock-lsp-apply",
          message: `applied=${applied} reason=${reason}`,
        },
      ],
    },
  });
}

function wordAt(text, position) {
  const line = text.split("\n")[position?.line ?? 0] ?? "";
  const before = line.slice(0, position?.character ?? 0).match(/[\w$]*$/)?.[0];
  const after = line.slice(position?.character ?? 0).match(/^[\w$]*/)?.[0];
  return `${before ?? ""}${after ?? ""}`;
}

/** One completion item, shaped like a TypeScript server's. */
function completionItem(index, uri, position) {
  const label = `symbol${index.toString(36)}Value`;
  const line = position?.line ?? 0;
  const character = position?.character ?? 0;
  return {
    label,
    kind: [2, 3, 5, 6, 7, 9, 10, 14, 21][index % 9],
    sortText: String(11 + (index % 5)),
    insertTextFormat: 1,
    textEdit: {
      range: {
        start: { line, character: Math.max(0, character - 2) },
        end: { line, character },
      },
      newText: label,
    },
    data: { uri, line: line + 1, offset: character + 1, entryNames: [label] },
  };
}

function completionAnswer(params) {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  const line = (documents.get(uri) ?? "").split("\n")[position?.line ?? 0];
  const afterDot = line?.[(position?.character ?? 0) - 1] === ".";
  const count = afterDot ? memberItems : completionItems;
  if (count <= 0)
    return [
      { label: "alpha", kind: 1 },
      { label: "beta", kind: 1 },
      { label: "伽马", kind: 1 },
    ];
  return {
    isIncomplete: false,
    items: Array.from({ length: count }, (_, index) =>
      completionItem(index, uri, position),
    ),
  };
}

function hoverText(word) {
  if (hoverBytes <= 0) return word;
  const head =
    "```typescript\nfunction " +
    word +
    "(options: Options): Promise<Result>\n```\n\n";
  const prose =
    "Resolves the value for the given options. The promise settles once the underlying request completes. ";
  return head + prose.repeat(Math.max(1, Math.ceil(hoverBytes / prose.length)));
}

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      if (refuseInitialize) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: "Could not find a valid mock installation. Exiting.",
          },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          capabilities: {
            textDocumentSync: 2,
            hoverProvider: true,
            completionProvider: { triggerCharacters: ["."] },
            renameProvider: { prepareProvider: true },
            documentFormattingProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            codeActionProvider: true,
          },
          serverInfo: { name: "mock-lsp", version: "0.1.0" },
        },
      });
      // A server-initiated request the proxy must answer itself: if it ever
      // reached a browser session, the test would see it there.
      send({
        jsonrpc: "2.0",
        id: "mock-configuration",
        method: "workspace/configuration",
        params: { items: [{ section: "mock" }] },
      });
      return;
    case "shutdown":
      send({ jsonrpc: "2.0", id, result: null });
      return;
    case "exit":
      exit(0);
      return;
    case "textDocument/didOpen": {
      const uri = params?.textDocument?.uri;
      const text = params?.textDocument?.text ?? "";
      documents.set(uri, text);
      diagnosticsFor(uri, text);
      if (applyEdit) requestApplyEdit(uri);
      return;
    }
    case "textDocument/didChange": {
      const uri = params?.textDocument?.uri;
      let text = documents.get(uri) ?? "";
      for (const change of params?.contentChanges ?? []) {
        // Only full-text changes are applied; the proxy's own shadow document
        // is what the incremental tests exercise.
        if (!change.range) text = change.text;
      }
      documents.set(uri, text);
      diagnosticsFor(uri, text);
      return;
    }
    case "textDocument/didClose":
      documents.delete(params?.textDocument?.uri);
      return;
    case "textDocument/hover": {
      if (hang) return;
      const uri = params?.textDocument?.uri;
      const word = wordAt(documents.get(uri) ?? "", params?.position);
      const contents = bigResponse
        ? "x".repeat(1024 * 1024)
        : hoverBytes > 0
          ? { kind: "markdown", value: hoverText(word) }
          : word;
      send({ jsonrpc: "2.0", id, result: { contents } });
      return;
    }
    case "textDocument/completion":
      send({ jsonrpc: "2.0", id, result: completionAnswer(params) });
      return;
    case "textDocument/formatting":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "# formatted\n",
          },
        ],
      });
      return;
    case "textDocument/rename": {
      // A cross-file edit: the point of the preview flow is that a rename is
      // not one file, so the mock always answers with two.
      const uri = params?.textDocument?.uri;
      const other = uri.replace(/[^/]+$/, "other.txt");
      const edit = (newText) => [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
          newText,
        },
      ];
      send({
        jsonrpc: "2.0",
        id,
        result: { changes: { [uri]: edit("new"), [other]: edit("new") } },
      });
      return;
    }
    case "textDocument/definition":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            uri: params?.textDocument?.uri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
          // Deliberately outside the workspace: the proxy must turn this into
          // an opaque external id rather than leaking an absolute path.
          {
            uri: "file:///usr/lib/elsewhere.txt",
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 1 },
            },
          },
        ],
      });
      return;
    case "textDocument/codeAction":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          { title: "with edit", edit: { changes: {} } },
          // Command-only: the proxy must drop this rather than offer an action
          // that would need `workspace/executeCommand` to apply.
          { title: "command only", command: { command: "mock.run" } },
        ],
      });
      return;
    default:
      if (id !== undefined && id !== null) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `no ${method}` },
        });
      }
  }
}

stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const split = buffer.indexOf("\r\n\r\n");
    if (split < 0) return;
    const header = buffer.subarray(0, split).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      stderr.write("mock-lsp: bad header\n");
      exit(2);
    }
    const length = Number(match[1]);
    if (buffer.length < split + 4 + length) return;
    const body = buffer
      .subarray(split + 4, split + 4 + length)
      .toString("utf8");
    buffer = buffer.subarray(split + 4 + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      stderr.write("mock-lsp: bad json\n");
      continue;
    }
    // A response to one of our own server-initiated requests needs no work;
    // it is enough that the proxy answered it at all. It is also not counted,
    // so `--crash-after` counts something a test can predict: the client's own
    // requests and notifications, in order.
    if (message.method === undefined) {
      if (message.id === APPLY_ID) reportApplyEdit(message.result);
      continue;
    }
    handled += 1;
    if (crashAfter > 0 && handled > crashAfter) {
      stderr.write("mock-lsp: crashing on purpose\n");
      exit(9);
    }
    handle(message);
  }
});

stdin.on("end", () => exit(0));
