/**
 * ERC-7201 namespaces by the slot the code really uses.
 *
 * OpenZeppelin matches namespaces by their `@custom:storage-location
 * erc7201:<id>` annotation and never checks the `bytes32` slot the code assigns
 * (`assembly { $.slot := LOCATION }`). The two can disagree. A changed
 * constant behind an unchanged annotation moves the storage while the layout
 * check passes; a corrected annotation over an unchanged constant leaves the
 * storage in place while the check reports a deleted namespace. Reading the
 * slot from the AST catches the first and fixes the second.
 */

import type { SolcOutput, StorageLayout } from "@openzeppelin/upgrades-core";
import { styleText } from "node:util";
import { LayoutIntegrityError } from "./errors.js";
import { namespaceLines, plain } from "./report.js";
// Not exported from the package index; the package has no exports map, and
// all exist since 1.46.0, the lowest version slotdiff accepts.
import { getStorageLocationAnnotation } from "@openzeppelin/upgrades-core/dist/storage/namespace.js";
import { calculateERC7201StorageLocation } from "@openzeppelin/upgrades-core/dist/utils/erc7201.js";
import { resolveBaseSlot } from "@openzeppelin/upgrades-core/dist/utils/erc7201-builtin.js";
import {
  normalizeUint256Literal,
  toBytes32Hex,
} from "@openzeppelin/upgrades-core/dist/utils/integer-literals.js";

export interface NamespaceSlot {
  /** `erc7201:<id>`, as annotated. */
  namespace: string;
  /** The slot the annotation implies. */
  expected: string;
  /** The slot the code assigns, when it could be read and is unique. */
  actual?: string;
  /**
   * `match`: the code uses the annotated slot. `mismatch`: it uses `actual`
   * instead. `conflict`: it assigns different slots in different places.
   * `unused`: no code assigns its slot (a namespace kept reserved).
   * `unread`: an assignment could not be evaluated.
   */
  status: "match" | "mismatch" | "conflict" | "unused" | "unread";
}

interface AstNode {
  nodeType?: string;
  id?: number;
  [key: string]: unknown;
}

/**
 * How each of `namespaces` (`erc7201:<id>` keys of `contract`'s layout,
 * `source.sol:Name`) is assigned in `output`. Only structs declared in the
 * contract or its bases count, as for OpenZeppelin: a sibling contract in the
 * same build (a V1 next to its V2, a test copy) may declare the same id.
 */
export function namespaceSlots(
  output: SolcOutput,
  contract: string,
  namespaces: string[],
): NamespaceSlot[] {
  const colon = contract.lastIndexOf(":");
  // Most derived first, as solc lists them: the order virtual calls resolve in.
  let linearized: number[] = [];
  walk(output.sources?.[contract.slice(0, colon)]?.ast, (node) => {
    if (node.nodeType === "ContractDefinition" && node.name === contract.slice(colon + 1)) {
      linearized = node.linearizedBaseContracts as number[];
    }
  });
  const bases = new Set(linearized);

  // Only code the contract can run counts: its bases (minus the functions they
  // override), libraries and free functions, not a sibling contract (a test
  // harness) in the same files.
  const byId = new Map<number, AstNode>();
  const touched = new Set<number>();
  const overridden = new Set<number>();
  for (const source of Object.values(output.sources ?? {})) {
    walk(source.ast as unknown as AstNode, (node) => {
      if (typeof node.id === "number") byId.set(node.id, node);
      // Any Solidity use of a local after its declaration, so a local is read
      // only when nothing but assembly reads it.
      if (node.nodeType === "Identifier") touched.add(node.referencedDeclaration as number);
      if (node.nodeType === "FunctionDefinition" && bases.has(node.scope as number)) {
        for (const base of (node.baseFunctions ?? []) as number[]) overridden.add(base);
      }
    });
  }
  // An overridden function can still run (through `super` or `Base.f()`), so
  // its assembly is set aside: it never gives a slot, but it keeps a namespace
  // it assigns from passing as unused.
  const assemblies: AstNode[] = [];
  const setAside: AstNode[] = [];
  for (const source of Object.values(output.sources ?? {})) {
    walk(source.ast as unknown as AstNode, (node) => {
      const sibling =
        node.nodeType === "ContractDefinition" &&
        node.contractKind !== "library" &&
        !bases.has(node.id as number);
      if (sibling) return false;
      if (overridden.has(node.id as number)) {
        walk(node, (inner) => {
          if (inner.nodeType === "InlineAssembly") setAside.push(inner);
        });
        return false;
      }
      if (node.nodeType === "InlineAssembly") assemblies.push(node);
    });
  }
  const ctx = { byId, linearized, bases, touched };

  // Struct id → every slot value assigned to a pointer of that struct (undefined: unreadable).
  const assigned = new Map<number, Array<string | undefined>>();
  // Structs assigned a slot only in set-aside code, and whether any pointer
  // that is not a struct (a mapping or an array) is assigned one.
  const hidden = new Set<number>();
  let untyped = false;
  // Whether a struct without an annotation is placed at a known slot: it may
  // hold a namespace's data under another name (a library's Layout, say).
  const unannotated = (struct: number) => {
    const node = byId.get(struct);
    return node === undefined || getStorageLocationAnnotation(node as never) === undefined;
  };
  let stray = false;
  for (const assembly of setAside) {
    forEachSlotAssignment(assembly, byId, (struct) => {
      if (struct === undefined) untyped = true;
      else hidden.add(struct);
    });
  }
  for (const assembly of assemblies) {
    const refs = (assembly.externalReferences ?? []) as Array<{
      declaration: number;
      src: string;
      suffix?: string;
    }>;
    const declarationAt = (src: unknown) => refs.find((r) => r.src === src)?.declaration ?? -1;
    walk(assembly.AST as AstNode, (node) => {
      if (node.nodeType !== "YulAssignment") return;
      for (const target of node.variableNames as AstNode[]) {
        if (typeof target.name !== "string") continue;
        if (!target.name.endsWith(".slot")) {
          touched.add(declarationAt(target.src));
          continue;
        }
        const pointer = byId.get(declarationAt(target.src));
        const struct = (pointer?.typeName as AstNode | undefined)?.referencedDeclaration;
        if (typeof struct !== "number") {
          untyped = true;
          continue;
        }
        const value = node.value as AstNode;
        const slot =
          value.nodeType === "YulLiteral"
            ? value.kind === "number"
              ? normalize(value.value)
              : undefined
            : resolveDecl(ctx, byId.get(declarationAt(value.src)));
        if (slot !== undefined && unannotated(struct)) stray = true;
        assigned.set(struct, [...(assigned.get(struct) ?? []), slot]);
      }
    });
  }

  return namespaces.map((namespace) => {
    const expected = calculateERC7201StorageLocation(namespace.slice("erc7201:".length));
    const structs = [...byId.values()].filter(
      (n) =>
        n.nodeType === "StructDefinition" &&
        bases.has(n.scope as number) &&
        getStorageLocationAnnotation(n as never) === namespace,
    );
    const slots = structs.flatMap((n) => assigned.get(n.id!) ?? []);
    const known = [...new Set(slots.filter((s) => s !== undefined))];
    if (slots.length === 0) {
      // Unused only when nothing could be placing it: no assignment in
      // set-aside code, none to a struct nested in it, none to an untyped
      // pointer, none to a struct without an annotation at a known slot.
      const nested = new Set(structs.flatMap((n) => [...nestedStructs(n, byId)]));
      const own = new Set(structs.map((n) => n.id!));
      const placed =
        untyped ||
        stray ||
        [...hidden].some(unannotated) ||
        [...own, ...nested].some((id) => hidden.has(id)) ||
        [...nested].some((id) => !own.has(id) && assigned.has(id));
      return { namespace, expected, status: placed ? "unread" : "unused" };
    }
    if (known.length > 1) return { namespace, expected, status: "conflict" };
    if (slots.includes(undefined)) {
      return { namespace, expected, status: "unread" };
    }
    const actual = known[0];
    return actual === expected
      ? { namespace, expected, actual, status: "match" }
      : { namespace, expected, actual, status: "mismatch" };
  });
}

export interface NamespacePair {
  old?: NamespaceSlot;
  next?: NamespaceSlot;
  /**
   * Why this pair fails the check: `<new>` assigns several slots (`conflict`),
   * leaves the old data behind (`moved`), or keeps the data in place under an
   * annotation that does not match (`mismatch`). `unread`: a slot could not be
   * read, so the pair could not be checked.
   */
  problem?: "conflict" | "moved" | "mismatch" | "unread";
}

export interface NamespaceCheck {
  /**
   * `old`'s layout with each paired namespace under its name in `<new>`, for
   * `diffLayouts`: OpenZeppelin then compares the structs of the same storage.
   * An unpaired namespace keeps its name, so one that is really gone is still
   * reported as deleted.
   */
  layout: StorageLayout;
  /** Every namespace of either side, old and new paired when they are the same storage. */
  pairs: NamespacePair[];
  /** `fail` when any pair has a problem other than `unread`; `unread` when a slot could not be read. */
  result: "pass" | "fail" | "unread";
  /** The CLI's namespace grid, with what each problem means; empty when nothing is worth showing. */
  explain(color?: boolean): string;
}

/**
 * Checks ERC-7201 namespaces by the slot the code uses, not the annotation
 * OpenZeppelin goes by. An old and a new namespace are the same storage when
 * the code uses the same slot (under the same annotation first), failing that
 * when they share an annotation, and failing that when the new annotation
 * names the slot where the old data is. A namespace of either layout missing
 * from that side's `namespaces` (or all of them, when it is absent) is unread.
 * Pass `layout` to `diffLayouts` in place of `old.layout`.
 */
export function checkNamespaces(
  old: { layout: StorageLayout; namespaces?: NamespaceSlot[] },
  next: { layout: StorageLayout; namespaces?: NamespaceSlot[] },
): NamespaceCheck {
  const unpaired = new Set(slotsOf(old, "old"));
  const pairs: NamespacePair[] = slotsOf(next, "new").map((n) => ({ next: n }));
  const sameSlot = (o: NamespaceSlot, n: NamespaceSlot) =>
    o.actual !== undefined && n.actual !== undefined && same(o.actual, n.actual);
  const rules: Array<(o: NamespaceSlot, n: NamespaceSlot) => boolean> = [
    (o, n) => sameSlot(o, n) && o.namespace === n.namespace,
    sameSlot,
    (o, n) => o.namespace === n.namespace,
    (o, n) => o.actual !== undefined && same(o.actual, n.expected),
  ];
  // Rule by rule over every namespace, so a weaker rule never takes a pair from a stronger one.
  for (const rule of rules) {
    for (const pair of pairs) {
      const o = pair.old ?? [...unpaired].find((o) => rule(o, pair.next!));
      if (o !== undefined && unpaired.delete(o)) pair.old = o;
    }
  }
  for (const o of unpaired) pairs.push({ old: o });
  for (const pair of pairs) pair.problem = problemOf(pair);

  // Renamed all at once, so two namespaces can swap names.
  const renames = new Map(
    pairs.flatMap((p) =>
      p.old !== undefined && p.next !== undefined ? [[p.old.namespace, p.next.namespace]] : [],
    ),
  );
  const oldNames = Object.keys(old.layout.namespaces ?? {});
  const renamed = oldNames.map((name) => renames.get(name) ?? name);
  // On a clash (an old namespace that stays keeps the name another would take)
  // nothing is renamed: OpenZeppelin then reports the moved one as deleted.
  const layout =
    new Set(renamed).size < renamed.length || renamed.every((to, i) => to === oldNames[i])
      ? old.layout
      : {
          ...old.layout,
          namespaces: Object.fromEntries(
            oldNames.map((name, i) => [renamed[i], old.layout.namespaces![name]]),
          ),
        };

  const problems = pairs.map((p) => p.problem);
  return {
    layout,
    pairs,
    result: problems.some((p) => p !== undefined && p !== "unread")
      ? "fail"
      : problems.includes("unread")
        ? "unread"
        : "pass",
    // Colored by default, as OpenZeppelin's reports are.
    explain: (color = true) =>
      namespaceLines(
        pairs,
        color ? (format, text) => styleText(format, text, { validateStream: false }) : plain,
      ).join("\n"),
  };
}

/**
 * One slot per namespace of `side.layout`. A namespace with no slot (a record
 * from before slots were recorded) is unread, never left to OpenZeppelin's
 * annotation-only match.
 */
function slotsOf(
  side: { layout: StorageLayout; namespaces?: NamespaceSlot[] },
  which: "old" | "new",
): NamespaceSlot[] {
  const misfit = slotsMisfit(side.layout, side.namespaces);
  if (misfit !== undefined) {
    throw new LayoutIntegrityError(
      `The ${which} namespace slots do not fit its layout: ${misfit}.`,
    );
  }
  const given = side.namespaces ?? [];
  const seen = new Set(given.map((n) => n.namespace));
  return [
    ...given,
    ...Object.keys(side.layout.namespaces ?? {})
      .filter((namespace) => !seen.has(namespace))
      .map((namespace): NamespaceSlot => ({
        namespace,
        expected: calculateERC7201StorageLocation(namespace.slice("erc7201:".length)),
        status: "unread",
      })),
  ];
}

// `<formula>:<id>`, as OpenZeppelin keys namespaces. Never a name like
// `__proto__`, which a plain object lookup would resolve on its prototype.
const NAMESPACE_KEY = /^[\w.-]+:\S/;
const SLOT = /^0x[0-9a-f]{64}$/i;

/**
 * Why `namespaces` cannot be the slots of `layout`'s namespaces, or undefined
 * when they can (or are absent). A slot for a namespace the layout lacks, or a
 * second one for the same namespace, could take another's place when
 * namespaces are paired, so either is refused. Internal, shared with records.
 */
export function slotsMisfit(layout: StorageLayout, namespaces: unknown): string | undefined {
  const names = Object.keys(layout.namespaces ?? {});
  const odd = names.find((name) => !NAMESPACE_KEY.test(name));
  if (odd !== undefined) return `${JSON.stringify(odd)} is not a storage location`;
  if (namespaces === undefined) return undefined;
  if (!Array.isArray(namespaces)) return "they are not a list";
  const seen = new Set<string>();
  for (const slot of namespaces) {
    if (!isSlot(slot)) return "a slot is malformed";
    if (!names.includes(slot.namespace)) return `${slot.namespace} is not in the layout`;
    if (seen.has(slot.namespace)) return `${slot.namespace} appears twice`;
    seen.add(slot.namespace);
  }
  return undefined;
}

// Well formed, and consistent with its status.
function isSlot(value: unknown): value is NamespaceSlot {
  const n = value as Partial<NamespaceSlot> | null;
  if (
    typeof n !== "object" ||
    n === null ||
    typeof n.namespace !== "string" ||
    typeof n.expected !== "string" ||
    !SLOT.test(n.expected) ||
    (n.actual !== undefined && (typeof n.actual !== "string" || !SLOT.test(n.actual)))
  ) {
    return false;
  }
  const read = n.actual !== undefined;
  const same = read && BigInt(n.actual!) === BigInt(n.expected);
  return n.status === "match"
    ? same
    : n.status === "mismatch"
      ? read && !same
      : (n.status === "unread" || n.status === "conflict" || n.status === "unused") && !read;
}

function problemOf({ old, next }: NamespacePair): NamespacePair["problem"] {
  if (next?.status === "conflict") return "conflict";
  if (old?.actual !== undefined && next?.actual !== undefined && !same(old.actual, next.actual)) {
    return "moved";
  }
  if (next?.status === "mismatch") return "mismatch";
  // An unused namespace has no data of that version to move: compared by annotation, as OpenZeppelin does.
  const unknown = (s?: NamespaceSlot) =>
    s !== undefined && s.actual === undefined && s.status !== "unused";
  if (unknown(old) || next?.status === "unread") {
    return "unread";
  }
  return undefined;
}

// Calls `found` with the struct id of each pointer assigned a `.slot` in
// `assembly`, or undefined for a pointer that is not a struct.
function forEachSlotAssignment(
  assembly: AstNode,
  byId: Map<number, AstNode>,
  found: (struct: number | undefined) => void,
): void {
  const refs = (assembly.externalReferences ?? []) as Array<{ declaration: number; src: string }>;
  walk(assembly.AST as AstNode, (node) => {
    if (node.nodeType !== "YulAssignment") return;
    for (const target of node.variableNames as AstNode[]) {
      if (typeof target.name !== "string" || !target.name.endsWith(".slot")) continue;
      const pointer = byId.get(refs.find((r) => r.src === target.src)?.declaration ?? -1);
      const struct = (pointer?.typeName as AstNode | undefined)?.referencedDeclaration;
      found(typeof struct === "number" ? struct : undefined);
    }
  });
}

// Every struct that `struct` holds, at any depth (in members, mappings and arrays).
function nestedStructs(struct: AstNode, byId: Map<number, AstNode>): Set<number> {
  const found = new Set<number>();
  const visit = (node: AstNode) =>
    walk(node, (n) => {
      if (n.nodeType !== "UserDefinedTypeName") return;
      const target = byId.get(n.referencedDeclaration as number);
      if (target?.nodeType === "StructDefinition" && !found.has(target.id!)) {
        found.add(target.id!);
        visit(target);
      }
    });
  visit(struct);
  return found;
}

function same(a: string, b: string): boolean {
  return BigInt(a) === BigInt(b);
}

// Visits every node; a visitor returning false skips the node's children.
function walk(node: unknown, visit: (node: AstNode) => boolean | void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (typeof node === "object" && node !== null) {
    if (visit(node as AstNode) === false) return;
    for (const child of Object.values(node)) walk(child, visit);
  }
}

interface Context {
  byId: Map<number, AstNode>;
  linearized: number[];
  bases: Set<number>;
  /** Declarations that Solidity code uses, or assembly assigns. */
  touched: Set<number>;
}

/**
 * The value of a constant, an immutable set where it is declared, or a local
 * that only assembly reads. A state variable's initial value is not read: it
 * lives in the implementation's storage, not the proxy's.
 */
function resolveDecl(ctx: Context, decl: AstNode | undefined, depth = 0): string | undefined {
  if (decl === undefined) return undefined;
  if (decl.stateVariable === true) {
    if (decl.mutability !== "constant" && decl.mutability !== "immutable") return undefined;
    return resolveExpr(ctx, decl.value as AstNode | undefined, depth);
  }
  if (ctx.touched.has(decl.id as number)) return undefined;
  return resolveExpr(ctx, initialValue(ctx.byId, decl) as AstNode | undefined, depth);
}

/**
 * The value of an expression: a reference to a constant or local, a call to a
 * no-argument function that returns one (OpenZeppelin's Initializable reads
 * its slot from `_initializableStorageSlot()`), the ERC-7201 formula, a
 * number literal or `erc7201("id")`.
 */
function resolveExpr(ctx: Context, e: AstNode | undefined, depth: number): string | undefined {
  if (e === undefined || depth > 8) return undefined;
  if (e.nodeType === "Identifier") {
    return resolveDecl(ctx, ctx.byId.get(e.referencedDeclaration as number), depth + 1);
  }
  if (e.nodeType === "FunctionCall" && e.kind === "functionCall") {
    const callee = e.expression as AstNode;
    const fn = ctx.byId.get(callee.referencedDeclaration as number);
    if (callee.nodeType !== "Identifier" || fn?.nodeType !== "FunctionDefinition") return undefined;
    if ((e.arguments as unknown[]).length > 0) return undefined;
    return resolveExpr(ctx, returned(override(ctx, fn)), depth + 1);
  }
  const id = formulaId(e);
  if (id !== undefined) return calculateERC7201StorageLocation(id);
  // OpenZeppelin would read any other literal, such as `hex"..."`, as a number.
  if (e.nodeType === "Literal" && e.kind !== "number") return undefined;
  try {
    return resolveBaseSlot(e as never);
  } catch {
    return undefined;
  }
}

/**
 * The implementation an internal call to `fn` reaches: the most derived
 * override of a virtual function in the bases, or `fn` itself (a free or
 * library function, which nothing overrides).
 */
function override(ctx: Context, fn: AstNode): AstNode {
  if (fn.virtual !== true || !ctx.bases.has(fn.scope as number)) return fn;
  for (const contract of ctx.linearized) {
    for (const node of ctx.byId.values()) {
      if (
        node.nodeType === "FunctionDefinition" &&
        node.scope === contract &&
        node.name === fn.name &&
        (node.parameters as { parameters: unknown[] }).parameters.length === 0 &&
        node.body
      ) {
        return node;
      }
    }
  }
  return fn;
}

// The expression of a function whose body is a single `return <expression>;`
// and that has no modifier, which could skip it.
function returned(fn: AstNode): AstNode | undefined {
  if ((fn.modifiers as unknown[] | undefined)?.length) return undefined;
  const statements = (fn.body as { statements?: AstNode[] } | null)?.statements;
  return statements?.length === 1 && statements[0].nodeType === "Return"
    ? (statements[0].expression as AstNode)
    : undefined;
}

// A local variable's value is on the statement that declares it.
function initialValue(byId: Map<number, AstNode>, decl: AstNode): unknown {
  for (const node of byId.values()) {
    if (node.nodeType !== "VariableDeclarationStatement") continue;
    const declarations = node.declarations as Array<AstNode | null>;
    if (declarations.length === 1 && declarations[0]?.id === decl.id) return node.initialValue;
  }
  return undefined;
}

/**
 * The id in the ERC-7201 formula written out in Solidity,
 * `keccak256(abi.encode(uint256(keccak256("id")) - 1)) & ~bytes32(uint256(0xff))`,
 * with an optional `bytes("id")`. Anything else is not recognized.
 */
function formulaId(e: AstNode): string | undefined {
  if (e.nodeType !== "BinaryOperation" || e.operator !== "&") return undefined;
  const mask = e.rightExpression as AstNode;
  const masked = arg(
    arg(
      mask.nodeType === "UnaryOperation" ? (mask.subExpression as AstNode) : undefined,
      "bytes32",
    ),
    "uint256",
  );
  if (masked?.nodeType !== "Literal" || normalize(masked.value) !== toBytes32Hex(0xffn)) {
    return undefined;
  }
  const minus = arg(arg(e.leftExpression as AstNode, "keccak256"), "abi.encode");
  if (minus?.nodeType !== "BinaryOperation" || minus.operator !== "-") return undefined;
  const one = minus.rightExpression as AstNode;
  if (one.nodeType !== "Literal" || one.value !== "1") return undefined;
  let id = arg(arg(minus.leftExpression as AstNode, "uint256"), "keccak256");
  if (id?.nodeType === "FunctionCall") id = arg(id, "bytes");
  return id?.nodeType === "Literal" && id.kind === "string" ? (id.value as string) : undefined;
}

// The single argument of a call to `name` (a function, `abi.encode`, or a type conversion).
function arg(call: AstNode | undefined, name: string): AstNode | undefined {
  if (call?.nodeType !== "FunctionCall") return undefined;
  const callee = call.expression as AstNode;
  const calleeName =
    callee.nodeType === "Identifier"
      ? callee.name
      : callee.nodeType === "MemberAccess"
        ? `${(callee.expression as AstNode).name}.${callee.memberName}`
        : callee.nodeType === "ElementaryTypeNameExpression"
          ? (callee.typeName as AstNode).name
          : undefined;
  const args = call.arguments as AstNode[];
  return calleeName === name && args.length === 1 ? args[0] : undefined;
}

// A number literal as a slot, or undefined when it is not one.
function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return normalizeUint256Literal(value);
  } catch {
    return undefined;
  }
}
