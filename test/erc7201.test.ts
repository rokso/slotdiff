/**
 * ERC-7201 slots read from real solc output: each way a namespace's slot is
 * written, and the comparison by real slot that OpenZeppelin's annotation-only
 * check cannot make.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { SolcInput } from "@openzeppelin/upgrades-core";
import { calculateERC7201StorageLocation } from "@openzeppelin/upgrades-core/dist/utils/erc7201.js";
import { analyzeSource } from "../src/reconstruct.js";
import { checkNamespaces, namespaceSlots, type NamespaceSlot } from "../src/erc7201.js";
import { diffLayouts } from "../src/diff.js";
import { LayoutIntegrityError, LayoutUnavailableError } from "../src/errors.js";
import type { StorageLayout } from "@openzeppelin/upgrades-core";
import { getSolc, type SolcRunner } from "../src/solc.js";

const SOLC = "0.8.24+commit.e11b9ed9";
const slot = (id: string) => calculateERC7201StorageLocation(id);

// A contract with one namespace `annotated`, whose getter body is `getter`.
function contract(annotated: string, getter: string, extra = ""): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract C {
    /// @custom:storage-location erc7201:${annotated}
    struct S { uint256 a; }
    ${extra}
    function _s() private pure returns (S storage $) { ${getter} }
    function a() external view returns (uint256) { return _s().a; }
}
`;
}

let solc: SolcRunner;

beforeAll(async () => {
  solc = await getSolc(SOLC);
}, 120_000);

async function analyze(content: string) {
  const input = {
    language: "Solidity",
    sources: { "src/C.sol": { content } },
    settings: { optimizer: { enabled: false, runs: 200 } },
  } as SolcInput;
  return analyzeSource(input, solc, "src/C.sol:C");
}

describe("namespace slots", () => {
  it.each([
    [
      "a hex constant",
      `bytes32 private constant L = ${slot("x.main")};`,
      "assembly { $.slot := L }",
    ],
    [
      "a constant referencing another",
      `bytes32 private constant L0 = ${slot("x.main")}; bytes32 private constant L = L0;`,
      "assembly { $.slot := L }",
    ],
    ["a literal in the assembly", "", `assembly { $.slot := ${slot("x.main")} }`],
    [
      "the formula, through a local variable",
      `bytes32 private constant L = keccak256(abi.encode(uint256(keccak256("x.main")) - 1)) & ~bytes32(uint256(0xff));`,
      "bytes32 l = L; assembly { $.slot := l }",
    ],
    [
      "the formula with bytes(id)",
      `bytes32 private constant L = keccak256(abi.encode(uint256(keccak256(bytes("x.main"))) - 1)) & ~bytes32(uint256(0xff));`,
      "bytes32 l = L; assembly { $.slot := l }",
    ],
  ])(
    "reads %s",
    async (_, extra, getter) => {
      const { namespaces } = await analyze(contract("x.main", getter, extra));
      expect(namespaces).toEqual([
        {
          namespace: "erc7201:x.main",
          expected: slot("x.main"),
          actual: slot("x.main"),
          status: "match",
        },
      ]);
    },
    60_000,
  );

  it("reads a namespace declared in a base contract", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
abstract contract Base {
    /// @custom:storage-location erc7201:x.base
    struct S { uint256 a; }
    function _s() internal pure returns (S storage $) { assembly { $.slot := ${slot("x.base")} } }
}
contract C is Base {
    function a() external view returns (uint256) { return _s().a; }
}
`;
    const { namespaces } = await analyze(content);
    expect(namespaces).toEqual([
      {
        namespace: "erc7201:x.base",
        expected: slot("x.base"),
        actual: slot("x.base"),
        status: "match",
      },
    ]);
  }, 60_000);

  it("reads a slot returned by a no-argument function, as OpenZeppelin's Initializable does", async () => {
    const extra = `bytes32 private constant L = ${slot("x.main")};
    function _slot() internal pure virtual returns (bytes32) { return L; }`;
    const { namespaces } = await analyze(
      contract("x.main", "bytes32 s = _slot(); assembly { $.slot := s }", extra),
    );
    expect(namespaces[0].status).toBe("match");
  }, 60_000);

  it("follows the most derived override of that function", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract Base {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    function _slot() internal pure virtual returns (bytes32) { return ${slot("x.main")}; }
    function _s() internal pure returns (S storage $) { bytes32 s = _slot(); assembly { $.slot := s } }
    function a() external view returns (uint256) { return _s().a; }
}
contract C is Base {
    function _slot() internal pure override returns (bytes32) { return ${slot("x.moved")}; }
}
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0]).toMatchObject({ actual: slot("x.moved"), status: "mismatch" });
  }, 60_000);

  it("does not follow a call with arguments, whose override it cannot pick", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract Base {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    function _slot(uint256) internal pure virtual returns (bytes32) { return ${slot("x.main")}; }
    function _s() internal pure returns (S storage $) { bytes32 s = _slot(1); assembly { $.slot := s } }
    function a() external view returns (uint256) { return _s().a; }
}
contract C is Base {
    function _slot(uint256) internal pure override returns (bytes32) { return ${slot("x.moved")}; }
}
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0].status).toBe("unread");
  }, 60_000);

  it("reports the slot the code uses when the annotation disagrees", async () => {
    const { namespaces } = await analyze(
      contract(
        "x.wrong",
        "assembly { $.slot := L }",
        `bytes32 private constant L = ${slot("x.real")};`,
      ),
    );
    expect(namespaces).toEqual([
      {
        namespace: "erc7201:x.wrong",
        expected: slot("x.wrong"),
        actual: slot("x.real"),
        status: "mismatch",
      },
    ]);
  }, 60_000);

  it("reports two different slots for one namespace as a conflict", async () => {
    const extra = `bytes32 private constant L = ${slot("x.main")};
    function _t() private pure returns (S storage $) { assembly { $.slot := ${slot("x.other")} } }`;
    const { namespaces } = await analyze(contract("x.main", "assembly { $.slot := L }", extra));
    expect(namespaces[0].status).toBe("conflict");
  }, 60_000);

  it("follows a getter that forwards to the one that assigns", async () => {
    const extra = `function _t() private pure returns (S storage $) { assembly { $.slot := ${slot("x.main")} } }`;
    const { namespaces } = await analyze(contract("x.main", "return _t();", extra));
    expect(namespaces[0].status).toBe("match");
  }, 60_000);

  it("leaves a slot computed at run time unread", async () => {
    const getter = 'bytes32 l = keccak256("other"); assembly { $.slot := l }';
    const { namespaces } = await analyze(contract("x.main", getter));
    expect(namespaces[0]).toEqual({
      namespace: "erc7201:x.main",
      expected: slot("x.main"),
      status: "unread",
    });
  }, 60_000);

  it("leaves a namespace unread when any of its assignments cannot be read", async () => {
    const extra = `function _t() private pure returns (S storage $) { bytes32 l = keccak256("x"); assembly { $.slot := l } }`;
    const { namespaces } = await analyze(
      contract("x.main", `assembly { $.slot := ${slot("x.main")} }`, extra),
    );
    expect(namespaces[0].status).toBe("unread");
  }, 60_000);

  it("marks a namespace the code never assigns unused, not unread", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract C {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
}
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0].status).toBe("unused");
  }, 60_000);
});

describe("unused namespaces", () => {
  // C's base declares S (with a nested struct and a mapping of it); with
  // `getter`, the base also assigns S's slot in a virtual getter.
  const statusOf = async (body: string, extra = "", getter = true) => {
    const base = getter
      ? `function _s() internal pure virtual returns (S storage $) { assembly { $.slot := ${slot("x.other")} } }`
      : "";
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
${extra}
contract Base {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; Inner inner; mapping(uint256 => Inner) byId; }
    struct Inner { uint256 b; }
    ${base}
}
contract C is Base {
    ${body}
}
`;
    return (await analyze(content)).namespaces[0].status;
  };

  // The base's assignment is set aside, but its code still runs through the override.
  it.each([
    ["super", "super._s()"],
    ["the base's name", "Base._s()"],
  ])(
    "is never claimed for a base getter reached through %s",
    async (_, call) => {
      const body = `function _s() internal pure override returns (S storage $) { return ${call}; }
    function a() external view returns (uint256) { return _s().a; }`;
      expect(await statusOf(body)).toBe("unread");
    },
    60_000,
  );

  it.each([
    ["a struct nested in it", "Inner"],
    ["a mapping", "mapping(uint256 => uint256)"],
  ])(
    "is never claimed when code assigns a slot to %s",
    async (_, type) => {
      // From a parameter: a known slot would stop the analysis (see below).
      const body = `function _p(bytes32 s) internal pure returns (${type} storage $) { assembly { $.slot := s } }`;
      expect(await statusOf(body, "", false)).toBe("unread");
    },
    60_000,
  );

  // OpenZeppelin's layout holds only the namespaces declared in the contract and
  // its bases; storage placed through any other struct would change unseen.
  it.each([
    [
      "a library's struct, next to an assigned namespace",
      `library L {
    struct Layout { uint256 a; }
    bytes32 internal constant SLOT = ${slot("x.lib")};
    function layout() internal pure returns (Layout storage $) { assembly { $.slot := SLOT } }
}`,
      "function b() external view returns (uint256) { return L.layout().a; }",
      true,
      "L.Layout",
    ],
    [
      "a struct without an annotation",
      "",
      `struct T { uint256 a; }
    function _t() internal pure returns (T storage $) { assembly { $.slot := ${slot("x.other")} } }`,
      false,
      "C.T",
    ],
    [
      "a struct nested in a namespace",
      "",
      `function _i() internal pure returns (Inner storage $) { assembly { $.slot := 1 } }`,
      false,
      "Base.Inner",
    ],
  ])(
    "refuses storage placed through %s at a known slot",
    async (_, extra, body, getter, name) => {
      await expect(statusOf(body, extra, getter)).rejects.toThrow(
        new RegExp(
          `keeps storage at a fixed slot through ${name.replace(".", "\\.")}, which is not`,
        ),
      );
    },
    60_000,
  );

  // The diamond and Solidstate pattern: OpenZeppelin skips such a struct with a warning.
  it("refuses a namespace declared in a library, whose fields no layout holds", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
library LibFoo {
    /// @custom:storage-location erc7201:foo.storage
    struct Layout { uint256 a; address b; }
    bytes32 internal constant SLOT = ${slot("foo.storage")};
    function layout() internal pure returns (Layout storage l) { assembly { l.slot := SLOT } }
}
contract C {
    function setA(uint256 v) external { LibFoo.layout().a = v; }
}
`;
    const err = await analyze(content).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LayoutUnavailableError);
    expect((err as Error).message).toContain("through LibFoo.Layout");
  }, 60_000);

  it("is never claimed when an overridden function places a struct without an annotation", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract Base {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    struct T { uint256 a; }
    function _t() internal pure virtual returns (T storage $) { assembly { $.slot := ${slot("x.main")} } }
}
contract C is Base {
    function _t() internal pure override returns (T storage $) { return super._t(); }
}
`;
    expect((await analyze(content)).namespaces[0].status).toBe("unread");
  }, 60_000);

  it("is unused when nothing assigns it", async () => {
    expect(await statusOf("", "", false)).toBe("unused");
  }, 60_000);

  it("stays unused next to an unrelated struct pointer, as OpenZeppelin's StorageSlot has", async () => {
    const lib = `library StorageSlot {
    struct AddressSlot { address value; }
    function getAddressSlot(bytes32 slot) internal pure returns (AddressSlot storage r) { assembly { r.slot := slot } }
}`;
    const body = `function owner() external view returns (address) { return StorageSlot.getAddressSlot(bytes32(uint256(1))).value; }`;
    expect(await statusOf(body, lib, false)).toBe("unused");
  }, 60_000);
});

describe("namespace slots the code may change", () => {
  it.each([
    ["in Solidity", "loc = Y;"],
    ["in assembly", "assembly { loc := Y }"],
    ["by delete", "delete loc;"],
  ])(
    "leaves a local assigned again %s unread",
    async (_, reassign) => {
      const extra = `bytes32 private constant L = ${slot("x.main")};
    bytes32 private constant Y = ${slot("y.main")};`;
      const getter = `bytes32 loc = L; ${reassign} assembly { $.slot := loc }`;
      const { namespaces } = await analyze(contract("x.main", getter, extra));
      expect(namespaces[0].status).toBe("unread");
    },
    60_000,
  );

  it("leaves a counter changed by ++ unread", async () => {
    const extra = `uint256 private constant L = ${slot("x.main")};`;
    const getter = "uint256 loc = L; loc++; assembly { $.slot := loc }";
    const { namespaces } = await analyze(contract("x.main", getter, extra));
    expect(namespaces[0].status).toBe("unread");
  }, 60_000);

  it("still reads a constant that is also used as a mapping key", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract C {
    /// @custom:storage-location erc7201:x.main
    struct S { mapping(bytes32 => uint256) m; }
    bytes32 private constant L = ${slot("x.main")};
    function _s() private pure returns (S storage $) { assembly { $.slot := L } }
    function f() external { _s().m[L] = 1; }
}
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0].status).toBe("match");
  }, 60_000);

  it("does not follow a function with a modifier, which could skip its body", async () => {
    const extra = `bool private constant F = false;
    modifier m() { if (F) { _; } }
    function _loc() internal pure m returns (bytes32) { return ${slot("x.main")}; }`;
    const getter = "bytes32 l = _loc(); assembly { $.slot := l }";
    const { namespaces } = await analyze(contract("x.main", getter, extra));
    expect(namespaces[0].status).toBe("unread");
  }, 60_000);

  it('leaves a hex"..." constant unread rather than reading it as slot 0', async () => {
    const extra = `bytes32 private constant L = hex"${slot("x.main").slice(2)}";`;
    const getter = "bytes32 l = L; assembly { $.slot := l }";
    const { namespaces } = await analyze(contract("x.main", getter, extra));
    expect(namespaces[0].status).toBe("unread");
  }, 60_000);

  it("reads an immutable set where it is declared, not one set in the constructor", async () => {
    const at = (init: string, ctor: string) => `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract C {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    bytes32 private immutable L${init};
    constructor() { ${ctor} }
    function _s() private view returns (S storage $) { bytes32 l = L; assembly { $.slot := l } }
    function a() external view returns (uint256) { return _s().a; }
}
`;
    expect((await analyze(at(` = ${slot("x.main")}`, ""))).namespaces[0].status).toBe("match");
    expect((await analyze(at("", `L = ${slot("x.main")};`))).namespaces[0].status).toBe("unread");
  }, 60_000);

  it("gives up on getters that call each other, instead of recursing forever", async () => {
    const extra = `function _p() internal pure returns (bytes32) { return _q(); }
    function _q() internal pure returns (bytes32) { return _p(); }`;
    const getter = "bytes32 l = _p(); assembly { $.slot := l }";
    const { namespaces } = await analyze(contract("x.main", getter, extra));
    expect(namespaces[0].status).toBe("unread");
  }, 60_000);

  it("ignores a base's storage getter that the contract overrides", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
abstract contract B {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    function _s() internal pure virtual returns (S storage $) { assembly { $.slot := ${slot("y.main")} } }
}
contract C is B {
    function _s() internal pure override returns (S storage $) { assembly { $.slot := ${slot("x.main")} } }
    function a() external view returns (uint256) { return _s().a; }
}
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0].status).toBe("match");
  }, 60_000);

  it("reads a slot a library assigns", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract C {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    function a() external view returns (uint256) { return L.s().a; }
}
library L {
    function s() internal pure returns (C.S storage $) { assembly { $.slot := ${slot("y.main")} } }
}
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0]).toMatchObject({ actual: slot("y.main"), status: "mismatch" });
  }, 60_000);

  it("ignores a sibling contract's struct with the same annotation", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract C {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    function _s() private pure returns (S storage $) { assembly { $.slot := ${slot("x.main")} } }
    function a() external view returns (uint256) { return _s().a; }
}
contract Other {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
}
// Free, so its assembly counts; it assigns Other's struct, not C's (from a
// parameter: a known slot would stop the analysis).
function otherS(bytes32 s) pure returns (Other.S storage $) { assembly { $.slot := s } }
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0].status).toBe("match");
  }, 60_000);

  it("does not read a state variable's initial value, which the proxy never stores", async () => {
    const extra = `bytes32 private loc = ${slot("x.main")};`;
    const getter = "bytes32 l = loc; assembly { $.slot := l }";
    const { namespaces } = await analyze(
      contract("x.main", getter, extra).replace(
        "private pure returns (S",
        "private view returns (S",
      ),
    );
    expect(namespaces[0].status).toBe("unread");
  }, 60_000);

  it("follows a free function, not a contract function of the same name", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
function _loc() pure returns (bytes32) { return ${slot("y.main")}; }
contract C {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    function _loc() internal pure virtual returns (bytes32) { return ${slot("x.main")}; }
    function a() external view returns (uint256) { return getS().a + uint256(_loc()); }
}
function getS() pure returns (C.S storage $) { bytes32 l = _loc(); assembly { $.slot := l } }
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0]).toMatchObject({ actual: slot("y.main"), status: "mismatch" });
  }, 60_000);

  it("ignores assembly in a contract the target does not inherit", async () => {
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract B {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    function _s() internal pure returns (S storage $) { assembly { $.slot := ${slot("x.main")} } }
}
contract C is B {
    function a() external view returns (uint256) { return _s().a; }
}
contract Harness is B {
    function at() external view returns (uint256) { S storage $; assembly { $.slot := 0 } return $.a; }
}
`;
    const { namespaces } = await analyze(content);
    expect(namespaces[0].status).toBe("match");
  }, 60_000);
});

describe("checkNamespaces", () => {
  it("compares an old namespace by the slot it really used", async () => {
    // The old annotation was wrong; the new one is fixed and the slot is unchanged.
    const old = await analyze(
      contract(
        "x.wrong",
        "assembly { $.slot := L }",
        `bytes32 private constant L = ${slot("x.real")};`,
      ),
    );
    const next = await analyze(
      contract(
        "x.real",
        "assembly { $.slot := L }",
        `bytes32 private constant L = ${slot("x.real")};`,
      ),
    );
    expect(diffLayouts(old.layout, next.layout).ok).toBe(false); // OpenZeppelin alone
    const checked = checkNamespaces(old, next);
    expect(checked.result).toBe("pass");
    expect(Object.keys(checked.layout.namespaces!)).toEqual(["erc7201:x.real"]);
    expect(diffLayouts(checked.layout, next.layout).ok).toBe(true);
  }, 60_000);

  it("fails a namespace whose data the new code leaves behind", async () => {
    // The old annotation was wrong; the new code changed the constant to match it.
    const old = await analyze(
      contract(
        "x.main",
        "assembly { $.slot := L }",
        `bytes32 private constant L = ${slot("y.main")};`,
      ),
    );
    const next = await analyze(
      contract(
        "x.main",
        "assembly { $.slot := L }",
        `bytes32 private constant L = ${slot("x.main")};`,
      ),
    );
    expect(diffLayouts(old.layout, next.layout).ok).toBe(true); // OpenZeppelin alone
    const checked = checkNamespaces(old, next);
    expect(checked.result).toBe("fail");
    expect(checked.pairs).toEqual([
      { old: old.namespaces[0], next: next.namespaces[0], problem: "moved" },
    ]);
  }, 60_000);

  it("swaps two namespaces whose annotations were swapped", () => {
    const old = {
      layout: layoutWith({ "erc7201:a": "A", "erc7201:b": "B" }),
      namespaces: [mismatch("a", slot("b")), mismatch("b", slot("a"))],
    };
    const checked = checkNamespaces(old, side([match("a"), match("b")]));
    expect(checked.result).toBe("pass");
    expect(checked.layout.namespaces).toEqual({ "erc7201:b": "A", "erc7201:a": "B" });
  });

  it("renames nothing onto a namespace the old layout keeps", () => {
    // Old `a` really used `b`'s slot, but old also has a `b` of its own.
    const old = {
      layout: layoutWith({ "erc7201:a": "A", "erc7201:b": "B" }),
      namespaces: [mismatch("a", slot("b")), mismatch("b", slot("c"))],
    };
    const checked = checkNamespaces(old, side([match("b")]));
    expect(checked.layout).toBe(old.layout);
  });

  it.each([
    ["the new slot", [match("a")], [unread("a")]],
    ["the old slot", [unread("a")], [match("a")]],
  ])("cannot check a namespace when %s is not read", (_, oldSlots, nextSlots) => {
    const old = { layout: layoutWith({ "erc7201:a": "A" }), namespaces: oldSlots };
    const checked = checkNamespaces(old, side(nextSlots));
    expect(checked.result).toBe("unchecked");
    expect(checked.pairs[0].problem).toBe("unread");
  });

  it("pairs by slot before it pairs by annotation", () => {
    // New `x` would take old `x` by name; new `z` holds old `x`'s data by slot.
    const old = {
      layout: layoutWith({ "erc7201:x": "X" }),
      namespaces: [mismatch("x", slot("s1"))],
    };
    const next = side([mismatch("x", slot("s9")), mismatch("z", slot("s1"))]);
    const { pairs } = checkNamespaces(old, next);
    expect(pairs.find((p) => p.old !== undefined)?.next?.namespace).toBe("erc7201:z");
  });

  it("pairs a namespace under the same annotation and slot first", () => {
    // New `b` uses `a`'s slot too; `a` stays `a`, and `b` is seen to move.
    const old = {
      layout: layoutWith({ "erc7201:a": "A", "erc7201:b": "B" }),
      namespaces: [match("a"), match("b")],
    };
    const next = side([mismatch("b", slot("a")), match("a")]);
    const { pairs } = checkNamespaces(old, next);
    expect(pairs.map((p) => [p.old?.namespace, p.next?.namespace, p.problem])).toEqual([
      ["erc7201:b", "erc7201:b", "moved"],
      ["erc7201:a", "erc7201:a", undefined],
    ]);
  });

  it("fails a new namespace that assigns several slots", () => {
    const conflict: NamespaceSlot = { ...unread("a"), status: "conflict" };
    const checked = checkNamespaces({ layout: layoutWith({}), namespaces: [] }, side([conflict]));
    expect(checked.result).toBe("fail");
    expect(checked.pairs[0].problem).toBe("conflict");
  });

  it("fails before it gives up: a failing namespace outranks an unread one", () => {
    const old = { layout: layoutWith({ "erc7201:a": "A", "erc7201:b": "B" }), namespaces: [] };
    const next = side([unread("a"), mismatch("b", slot("c"))]);
    expect(checkNamespaces(old, next).result).toBe("fail");
  });

  it("cannot check old namespaces with no slots, as in an older record", () => {
    const old = { layout: layoutWith({ "erc7201:a": "A" }) };
    const checked = checkNamespaces(old, side([match("a")]));
    expect(checked.result).toBe("unchecked");
    expect(checked.pairs).toEqual([{ old: unread("a"), next: match("a"), problem: "unread" }]);
  });

  it("cannot check an old namespace missing from the slots given", () => {
    const old = {
      layout: layoutWith({ "erc7201:a": "A", "erc7201:b": "B" }),
      namespaces: [match("a")],
    };
    const checked = checkNamespaces(old, side([match("a"), match("b")]));
    expect(checked.result).toBe("unchecked");
    expect(checked.pairs.map((p) => [p.old?.namespace, p.problem])).toEqual([
      ["erc7201:a", undefined],
      ["erc7201:b", "unread"],
    ]);
  });

  it("still fails a problem in <new> when the old slots are unknown", () => {
    const old = { layout: layoutWith({ "erc7201:a": "A" }) };
    const checked = checkNamespaces(old, side([mismatch("a", slot("c"))]));
    expect(checked.result).toBe("fail");
  });

  it.each([
    ["no slots at all", undefined],
    ["a slot for another namespace only", [match("b")]],
  ])("cannot check a new namespace with %s", (_, slots) => {
    // The new slot is unknown, so a moved namespace under the same annotation must not pass.
    const old = side([match("a")]);
    const layout = layoutWith({ "erc7201:a": "A", "erc7201:b": "B" });
    const checked = checkNamespaces(old, { layout, namespaces: slots });
    expect(checked.result).toBe("unchecked");
    expect(checked.pairs.find((p) => p.old !== undefined)).toEqual({
      old: match("a"),
      next: unread("a"),
      problem: "unread",
    });
  });

  it.each([
    ["a namespace the layout lacks", [mismatch("x", slot("y")), match("ghost")]],
    ["a namespace twice", [mismatch("x", slot("y")), { ...match("x"), actual: slot("x") }]],
  ])("refuses old slots with %s, which could hide a moved namespace", (_, slots) => {
    // Old x really used y's slot and new x uses x's: the data moves. A stray
    // entry holding x's slot would otherwise pair with new x and pass.
    const old = { layout: layoutWith({ "erc7201:x": "X" }), namespaces: slots };
    expect(() => checkNamespaces(old, side([match("x")]))).toThrow(LayoutIntegrityError);
  });

  it("refuses new slots that do not match the new layout", () => {
    const next = { layout: layoutWith({}), namespaces: [match("x")] };
    expect(() => checkNamespaces(side([]), next)).toThrow(
      /new namespace slots do not fit its layout: erc7201:x is not in the layout/,
    );
  });

  it.each([
    ["a name a plain object resolves on its prototype", JSON.parse('{"__proto__": "X"}')],
    ["a name with no formula", { constructor: "X" }],
  ])("refuses a layout namespace with %s", (_, namespaces) => {
    const old = { layout: { storage: [], types: {}, namespaces } as unknown as StorageLayout };
    expect(() => checkNamespaces(old, side([]))).toThrow(/is not a storage location/);
  });

  it("refuses a hand-built slot that is not a bytes32, with a clean error", () => {
    const bad = { ...match("x"), actual: "zz" };
    expect(() => checkNamespaces(side([bad]), side([match("x")]))).toThrow(LayoutIntegrityError);
  });

  it.each([
    ["unused on both sides", [unused("a")], [unused("a")], "pass", undefined],
    ["unused, then assigned its annotated slot", [unused("a")], [match("a")], "pass", undefined],
    ["assigned, then unused", [match("a")], [unused("a")], "pass", undefined],
    [
      "unused, then assigned elsewhere",
      [unused("a")],
      [mismatch("a", slot("b"))],
      "fail",
      "mismatch",
    ],
    ["unused, then unreadable", [unused("a")], [unread("a")], "unchecked", "unread"],
    // The deployed slot is known only while some code assigns it.
    [
      "assigned off its annotation, then unused",
      [mismatch("a", slot("b"))],
      [unused("a")],
      "fail",
      "dropped",
    ],
  ])("checks a namespace %s", (_, oldSlots, nextSlots, result, problem) => {
    const checked = checkNamespaces(side(oldSlots), side(nextSlots));
    expect([checked.result, checked.pairs[0].problem]).toEqual([result, problem]);
  });

  it("renames nothing when the slots already line up", async () => {
    const c = await analyze(
      contract(
        "x.main",
        "assembly { $.slot := L }",
        `bytes32 private constant L = ${slot("x.main")};`,
      ),
    );
    const checked = checkNamespaces(c, c);
    expect(checked.result).toBe("pass");
    expect(checked.layout).toBe(c.layout);
  }, 60_000);
});

// A side whose layout holds exactly the namespaces it has slots for.
function side(namespaces: NamespaceSlot[]) {
  return {
    layout: layoutWith(Object.fromEntries(namespaces.map((n) => [n.namespace, n.namespace]))),
    namespaces,
  };
}

// Synthetic layouts: only the namespace keys matter here, so members are a label.
function layoutWith(namespaces: Record<string, string>): StorageLayout {
  return { storage: [], types: {}, namespaces } as unknown as StorageLayout;
}

function match(id: string): NamespaceSlot {
  return { namespace: `erc7201:${id}`, expected: slot(id), actual: slot(id), status: "match" };
}

function mismatch(id: string, actual: string): NamespaceSlot {
  return { namespace: `erc7201:${id}`, expected: slot(id), actual, status: "mismatch" };
}

function unused(id: string): NamespaceSlot {
  return { namespace: `erc7201:${id}`, expected: slot(id), status: "unused" };
}

function unread(id: string): NamespaceSlot {
  return { namespace: `erc7201:${id}`, expected: slot(id), status: "unread" };
}

describe("namespaceSlots from existing compiler output", () => {
  it("reads slots without another compile, as a build tool's output gives them", async () => {
    // Only ASTs are needed; Hardhat 3 keys sources as project/...
    const output = await solc.compile({
      language: "Solidity",
      sources: {
        "project/contracts/C.sol": {
          content: contract("x.main", `assembly { $.slot := ${slot("x.other")} }`),
        },
      },
      settings: { outputSelection: { "*": { "": ["ast"] } } },
    } as SolcInput);
    expect(namespaceSlots(output, "project/contracts/C.sol:C", ["erc7201:x.main"])).toEqual([
      {
        namespace: "erc7201:x.main",
        expected: slot("x.main"),
        actual: slot("x.other"),
        status: "mismatch",
      },
    ]);
  });
});
