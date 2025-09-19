#!/usr/bin/env bash
set -euo pipefail

NAME=${1:?usage: new-target <name>}
LOW=$(echo "$NAME" | tr 'A-Z' 'a-z' | tr ' ' '-')

mkdir -p "src/targets/${LOW}" "test/targets/${LOW}" "targets/${LOW}"

cat > "src/targets/${LOW}/Exploit.sol" <<'SOL'
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface ITarget { /* fill minimal interface here */ }

contract Exploit {
    address public immutable target;
    constructor(address _target) { target = _target; }
    receive() external payable {}
    function pwn() external { /* implement exploit path */ }
}
SOL

cat > "test/targets/${LOW}/Exploit.t.sol" <<'SOL'
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {Exploit} from "src/targets/NAME/Exploit.sol";

contract ExploitTest is Test {
    address constant TARGET = address(0); // set deployed address
    Exploit exp;

    function setUp() public {
        exp = new Exploit(TARGET);
    }

    function test_Sanity() public {
        uint256 cid = block.chainid;
        emit log_named_uint("chainid", cid);
        assertTrue(true);
    }
}
SOL

# replace NAME with folder name in import
sed -i '' "s|NAME|${LOW}|g" "test/targets/${LOW}/Exploit.t.sol"

cat > "targets/${LOW}/README.md" <<EOF2
# ${NAME}

## Vector
- TBD

## Preconditions
- TBD

## Reproduction
Terminal A:
  BLOCK=<block> ./scripts/fork.sh optimism
Terminal B:
  RPC=optimism BLOCK=<block> ./scripts/run-tests.sh
EOF2

echo "Scaffold created at src/targets/${LOW}, test/targets/${LOW}, targets/${LOW}"
