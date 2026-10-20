/**
 * `slotdiff <old> <new>`: each side is a contract in the project's build info
 * or an address: a proxy (read as the implementation it runs now) or an
 * implementation.
 *
 * Exit codes: 0 every check ran and passed (or was skipped with --no-safety),
 * 1 a check failed, 2 something could not be checked. Failing to check is
 * never reported as compatible.
 */

import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs, styleText } from "node:util";
import { findBuildInfo } from "./build-info.js";
import { readCode, readProxy, type EthProvider } from "./chain.js";
import {
  checkLines,
  namespaceLines,
  plain,
  unassignedCount,
  type Check,
  type Paint,
} from "./report.js";
import { errorCode, LayoutUnavailableError, printable } from "./errors.js";
import { canQueryExplorer } from "./explorer.js";
import { rebuild } from "./resolve.js";
import {
  analyzeSource,
  SAFETY_ERROR_KINDS,
  type ProxyKind,
  type SafetyErrorKind,
  type SourceAnalysis,
} from "./reconstruct.js";
import { getSolc } from "./solc.js";
import { checkUpgrade } from "./upgrade.js";

const USAGE = `Usage: slotdiff <old> <new> [options]

Checks that <new> can replace <old> behind a proxy: OpenZeppelin's storage layout
rules, that each ERC-7201 namespace stays in the slot the code really uses, and
OpenZeppelin's safety rules for <new> (constructors, initializers, selfdestruct...).
Each side is either:
  a contract in this project's build info   src/Vault.sol:Vault, or Vault when unique
  an address                                a proxy (the implementation it runs now),
                                            or for <new>, an implementation

Options:
  --rpc <url>                 JSON-RPC endpoint, required when a side is an address
  --root <dir>                Project root (default: the current directory)
  --build-info <file>         Read local sides from this build-info file, as is
                              (not compared with the sources on disk)
  --explorer-url <url>        Another Etherscan-compatible API, such as Blockscout
  --unsafe-allow-renames      Accept renames without @custom:oz-renamed-from
  --unsafe-allow <kinds>      Comma-separated safety errors to accept, e.g. constructor;
                              prefer @custom:oz-upgrades-unsafe-allow in the source
  --no-safety                 Skip the safety rules
  --old-implementation        <old> is an implementation address, not a proxy; also
                              for a proxy slotdiff cannot read (pass its implementation)
  -h, --help                  Show this help
  -v, --version               Show the version

An address needs verified source: set ETHERSCAN_API_KEY once (one key covers every
chain), or use --explorer-url, with that explorer's key in its query if it needs one
(ETHERSCAN_API_KEY is sent only to Etherscan). --rpc picks the chain for each run.

Exit codes: 0 every check passed (or was skipped with --no-safety), 1 a check
failed, 2 something could not be checked.

A pass means these checks found no problem, not that an upgrade is safe in every
way. No warranty; see LICENSE.`;

const HELP_HINT = "Run slotdiff --help for usage.";

// "slot" and "diff" in block letters, split where the two words meet.
const BANNER: Array<[string, string]> = [
  ["     _       _  ", "    _ _  __  __"],
  [" ___| | ___ | |_", " __| (_)/ _|/ _|"],
  ["/ __| |/ _ \\| __", "/ _` | | |_| |_"],
  ["\\__ \\ | (_) | |", "| (_| | |  _|  _|"],
  ["|___/_|\\___/ \\__", "\\__,_|_|_| |_|"],
];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  /** stdout is an interactive terminal: show the banner. */
  tty?: boolean;
  /** stdout takes colors (Node's rules: a terminal, `NO_COLOR`, `FORCE_COLOR`). */
  color?: boolean;
}

interface Side {
  /** Two lines: what it is, then where it came from. Addresses in full, to copy. */
  description: [string, string];
  /** Inferred from the implementation's code, or `beacon` for a beacon proxy. */
  kind: ProxyKind;
  analysis: SourceAnalysis;
}

/** Runs the CLI and resolves to its exit code. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        rpc: { type: "string" },
        root: { type: "string" },
        "build-info": { type: "string" },
        "explorer-url": { type: "string" },
        "unsafe-allow-renames": { type: "boolean" },
        "unsafe-allow": { type: "string" },
        "no-safety": { type: "boolean" },
        "old-implementation": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    // Node's text for an unknown option runs on about `--`; the option is enough.
    const message = (e as Error).message;
    const unknown = /^Unknown option '([^']+)'/.exec(message)?.[1];
    const text = unknown !== undefined ? `Unknown option ${unknown}` : message;
    io.stderr(`${text.replace(/\.?$/, ".")} ${HELP_HINT}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const paint: Paint = io.color
    ? (format, text) => styleText(format, text, { validateStream: false })
    : plain;
  // Only for a person at a terminal: never in a pipe, a log or CI.
  const banner = async () =>
    [
      ...BANNER.map(([slot, diff]) => paint("blueBright", slot) + paint("magenta", diff)),
      ` ${paint("dim", `storage layout diff for upgradeable contracts · ${await packageVersion()}`)}`,
    ].join("\n");
  if (values.help) {
    io.stdout(io.tty ? `${await banner()}\n\n${USAGE}` : USAGE);
    return 0;
  }
  if (values.version) {
    io.stdout(io.tty ? await banner() : await packageVersion());
    return 0;
  }
  if (positionals.length !== 2) {
    io.stderr(`Expected <old> and <new>, got ${positionals.length} argument(s). ${HELP_HINT}`);
    return 2;
  }
  if (positionals.some((p) => p.includes("://"))) {
    // Not echoed: an RPC URL usually carries an API key.
    io.stderr("A side looks like a URL. Pass the endpoint with --rpc <url>.");
    return 2;
  }
  const short = positionals.find((p) => /^0x[0-9a-fA-F]*$/.test(p) && !ADDRESS.test(p));
  if (short !== undefined) {
    io.stderr(`${short} is not an address: an address is 0x and 40 hex digits.`);
    return 2;
  }
  const hasAddress = positionals.some((p) => ADDRESS.test(p));
  if (values.rpc === undefined && hasAddress) {
    io.stderr("An address needs --rpc <url>.");
    return 2;
  }

  const oldImplementation = values["old-implementation"] === true;
  if (oldImplementation && !ADDRESS.test(positionals[0])) {
    io.stderr("--old-implementation needs <old> to be an address.");
    return 2;
  }

  const safety = !values["no-safety"];
  if (!safety && values["unsafe-allow"] !== undefined) {
    io.stderr("--unsafe-allow does nothing with --no-safety.");
    return 2;
  }
  const unsafeAllow = (values["unsafe-allow"]?.split(",") ?? [])
    .map((k) => k.trim())
    .filter((k) => k !== "") as SafetyErrorKind[];
  const unknownKind = unsafeAllow.find(
    (k) => !(SAFETY_ERROR_KINDS as readonly string[]).includes(k),
  );
  if (unknownKind !== undefined) {
    io.stderr(
      `--unsafe-allow: unknown error kind "${unknownKind}". Known: ${SAFETY_ERROR_KINDS.join(", ")}.`,
    );
    return 2;
  }

  // Neither URL is ever echoed: endpoints often carry an API key.
  let rpcUrl: URL | undefined;
  try {
    rpcUrl = values.rpc !== undefined ? httpUrl(values.rpc, "--rpc") : undefined;
    const explorerUrl = values["explorer-url"];
    if (explorerUrl !== undefined && hasCredentials(httpUrl(explorerUrl, "--explorer-url"))) {
      throw new Error("--explorer-url must not include a user name or password.");
    }
  } catch (e) {
    io.stderr((e as Error).message);
    return 2;
  }

  const cwd = io.cwd ?? process.cwd();
  const root = resolve(cwd, values.root ?? ".");
  const buildInfoFile =
    values["build-info"] !== undefined ? resolve(cwd, values["build-info"]) : undefined;
  const env = io.env ?? process.env;
  // The Etherscan key goes to Etherscan only, never to another explorer's URL.
  const explorer =
    values["explorer-url"] !== undefined
      ? { apiUrl: values["explorer-url"] }
      : { apiKey: env.ETHERSCAN_API_KEY };
  const provider = rpcUrl !== undefined ? jsonRpcProvider(rpcUrl, io.fetch ?? fetch) : undefined;

  if (io.tty) io.stdout(`${await banner()}\n`);

  const readSide = async (spec: string, side: "old" | "new"): Promise<Side> => {
    if (ADDRESS.test(spec)) {
      // A proxy stands for what it runs now. <new> may be an implementation, but
      // <old> only when said so: a proxy of a kind slotdiff cannot read (a
      // diamond, a custom slot) would otherwise be compared as its own code.
      const proxy = await readProxy(provider!, spec);
      if (side === "old" && (proxy === undefined) !== oldImplementation) {
        // An address with no code is reported as such.
        if (proxy === undefined) await readCode(provider!, spec);
        throw new Error(
          proxy === undefined
            ? `${spec.toLowerCase()} is not a proxy slotdiff can read (no ERC-1967 implementation ` +
                "or beacon slot is set). If it is an implementation, or a proxy of another kind " +
                "given by its implementation's address, pass --old-implementation."
            : `${spec.toLowerCase()} is a proxy, not an implementation: drop --old-implementation.`,
        );
      }
      const implementation = proxy?.implementation ?? spec.toLowerCase();
      if (!canQueryExplorer(explorer)) {
        await readCode(provider!, implementation); // a wrong address is reported as such first
        throw new Error(
          `${implementation} needs an explorer key to fetch its verified source: set ` +
            "ETHERSCAN_API_KEY (or use --explorer-url for another explorer).",
        );
      }
      const { record, analysis } = await rebuild(provider!, implementation, { explorer });
      return {
        description: [
          proxy === undefined
            ? `${implementation} (implementation)`
            : `${spec.toLowerCase()} → implementation ${implementation}` +
              (proxy.beacon !== undefined ? ` (via beacon ${proxy.beacon})` : ""),
          `${record.contract} (verified source, ${record.bytecodeMatch} match)`,
        ],
        kind: proxy?.beacon !== undefined ? "beacon" : analysis.kind,
        analysis,
      };
    }
    const build = await findBuildInfo(root, spec, { file: buildInfoFile });
    const solc = await getSolc(build.solcVersion);
    const analysis = await analyzeSource(build.input, solc, build.contract);
    return {
      description: [
        build.contract,
        relative(root, build.file) +
          (buildInfoFile !== undefined ? " (as given, not compared with the sources on disk)" : ""),
      ],
      kind: analysis.kind,
      analysis,
    };
  };

  let old: Side;
  let next: Side;
  try {
    old = await readSide(positionals[0], "old");
    // The same side twice (e.g. a proxy against itself) is fetched and compiled once.
    next = positionals[1] === positionals[0] ? old : await readSide(positionals[1], "new");
  } catch (e) {
    // Messages can quote an explorer or verified source.
    io.stderr(`Could not check: ${printable((e as Error).message)}`);
    return 2;
  }

  for (const [label, side] of [
    ["old", old],
    ["new", next],
  ] as const) {
    io.stdout(
      `${paint("bold", label)}  ${side.description[0]}\n     ${paint("dim", side.description[1])}`,
    );
  }

  // The kind comes from <old>, the proxy being upgraded: inferring it from <new>
  // would miss a UUPS implementation that lost its upgrade function.
  const upgrade = checkUpgrade({ ...old.analysis, kind: old.kind }, next.analysis, {
    unsafeAllowRenames: values["unsafe-allow-renames"],
    unsafeAllow,
    skipSafety: !safety,
  });
  const { layout: report, namespaces, safety: safetyCheck } = upgrade;
  const grid = namespaceLines(namespaces.pairs, paint);
  if (grid.length > 0) io.stdout(`\n${grid.join("\n")}`);

  const renames = values["unsafe-allow-renames"] ? " (renames accepted)" : "";
  const checks: Check[] = [
    report.ok
      ? { name: "Storage layout", status: "pass", summary: `compatible${renames}` }
      : {
          name: "Storage layout",
          status: "fail",
          summary: `incompatible${renames}`,
          details: report.explain(),
        },
  ];

  if (namespaces.pairs.length > 0) {
    checks.push({
      name: "ERC-7201 slots",
      ...(namespaces.result === "fail"
        ? { status: "fail", summary: "problems found in <new> (see above)" }
        : namespaces.result === "unread"
          ? { status: "skip", summary: "not checked: some slots could not be read (see above)" }
          : {
              status: "pass",
              summary:
                (grid.length > 0
                  ? "compared by the slot in code (see above)"
                  : "match their annotations") + unassigned(unassignedCount(namespaces.pairs)),
            }),
    });
  }

  const accepted = unsafeAllow.length > 0 ? `; accepted: ${unsafeAllow.join(", ")}` : "";
  checks.push(
    safetyCheck === undefined
      ? { name: "Safety rules", status: "skip", summary: "skipped (--no-safety)" }
      : safetyCheck.ok
        ? {
            name: "Safety rules",
            status: "pass",
            summary: `no problems found (${old.kind} proxy${accepted})`,
          }
        : {
            name: "Safety rules",
            status: "fail",
            summary: `problems found (${old.kind} proxy${accepted})`,
            details: safetyCheck.explain(),
          },
  );
  io.stdout(`\n${checkLines(checks, paint).join("\n")}`);

  // One verdict, so a passing check next to a failing one is never read as safe.
  if (upgrade.result === "fail") {
    const problems = [
      ...(report.ok ? [] : ["the storage layout is incompatible"]),
      ...(namespaces.result === "fail" ? ["an ERC-7201 namespace fails the slot check"] : []),
      ...(safetyCheck?.ok === false ? ["<new> breaks the safety rules"] : []),
    ];
    io.stdout(`\n${paint(["bold", "red"], "Not safe to upgrade:")} ${problems.join(" and ")}.`);
    return 1;
  }
  if (upgrade.result === "unchecked") {
    io.stdout(
      `\n${paint(["bold", "yellow"], "Could not check:")} some ERC-7201 slots could not be read.`,
    );
    return 2;
  }
  io.stdout(
    safetyCheck === undefined
      ? `\n${paint("yellow", "Storage layout compatible; safety rules not checked (--no-safety).")}`
      : `\n${paint(["bold", "green"], "Safe to upgrade.")}`,
  );
  return 0;
}

function unassigned(count: number): string {
  if (count === 0) return "";
  return `; ${count} not assigned in code, compared by annotation`;
}

function httpUrl(value: string, flag: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} is not a valid URL; it needs a scheme, such as https://.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${flag} must be an http or https URL.`);
  }
  return url;
}

function hasCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

/**
 * A minimal JSON-RPC client. Errors never include the URL: endpoints often
 * carry an API key in the path or query. Credentials in the URL, which fetch
 * refuses, are sent as basic auth instead.
 */
function jsonRpcProvider(url: URL, fetchImpl: FetchLike): EthProvider {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (hasCredentials(url)) {
    const user = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.authorization = `Basic ${Buffer.from(user).toString("base64")}`;
    url = new URL(url);
    url.username = "";
    url.password = "";
  }
  const endpoint = url.href;
  let id = 0;
  return {
    async send(method, params) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
      } catch (e) {
        throw new LayoutUnavailableError(`Cannot reach the RPC endpoint (${errorCode(e)}).`);
      }
      if (!response.ok) {
        throw new LayoutUnavailableError(`The RPC endpoint answered HTTP ${response.status}.`);
      }
      let body: { result?: unknown; error?: { message?: string } };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        body = {};
      }
      if (typeof body !== "object" || body === null || !("result" in body || "error" in body)) {
        throw new LayoutUnavailableError(`The RPC endpoint did not answer JSON-RPC.`);
      }
      if (body.error !== undefined) {
        // The server's text, without control characters (terminal escapes) and capped.
        const message = printable(String(body.error.message ?? "unknown error"))
          .replace(/\s/g, " ")
          .slice(0, 300);
        throw new Error(`RPC ${method} failed: ${message}`);
      }
      return body.result;
    },
  };
}

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}
