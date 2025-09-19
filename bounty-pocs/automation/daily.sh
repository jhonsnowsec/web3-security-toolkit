#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)/bounty-pocs"

bash "$root/recon/scripts/refresh-tvl.sh"
bash "$root/recon/scripts/fetch-programs.sh"

target="${TARGET_NAME:-alchemix-transmuter}"   # export TARGET_NAME=seu-alvo
mkdir -p "$root/src/targets/$target" "$root/test/targets/$target" "$root/reports/draft"

# se não existir Exploit do alvo, copia um template mínimo
if [ ! -f "$root/src/targets/$target/Exploit.sol" ]; then
  cat > "$root/src/targets/$target/Exploit.sol" <<'SOL'
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
interface ITarget {}
contract Exploit {
    address public immutable target;
    constructor(address _target){ target = _target; }
    receive() external payable {}
    function pwn() external {}
}
SOL
fi

if [ ! -f "$root/test/targets/$target/Exploit.t.sol" ]; then
  cat > "$root/test/targets/$target/Exploit.t.sol" <<'SOL'
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../../../src/targets/REPLACE/Exploit.sol";

contract ExploitTest is Test {
    address target = vm.envAddress("TARGET");
    function setUp() public {
        string memory rpc = vm.envString("RPC_URL");
        uint256 blockNum = vm.envUint("BLOCK");
        vm.createSelectFork(rpc, blockNum);
    }
    function test_Exploit() public {
        Exploit e = new Exploit(target);
        assertTrue(true);
    }
}
SOL
  sed -i.bak "s/REPLACE/$target/g" "$root/test/targets/$target/Exploit.t.sol" && rm -f "$root/test/targets/$target/Exploit.t.sol.bak"
fi

# KPI mínimo
mkdir -p "$root/automation"
echo "{\"date\":\"$(date +%F)\",\"target\":\"$target\"}" >> "$root/automation/kpi.log"
echo "[ok] daily preparado para $target"
