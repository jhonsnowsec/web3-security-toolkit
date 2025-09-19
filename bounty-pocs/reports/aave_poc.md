
# 📄 reports/aave\_poc.md

````markdown
# 🧪 PoC – Aave Flashloan & Oracle Manipulation

## 📌 Contexto
- **Projeto**: bounty-pocs  
- **Alvo**: Aave V2 (Ethereum Mainnet @ block 20,750,000)  
- **Objetivo**: Validar uso de flashloans como base para exploração de oráculos / liquidações incorretas.  

---

## 🔹 Setup
1. Fork da mainnet:
   ```bash
   forge test \
     --match-path test/targets/aave/AaveOracleTest.t.sol \
     --fork-url $RPC_MAINNET \
     --fork-block-number 20750000 \
     -vvvv
````

2. RPC usado:

   ```
   RPC_MAINNET = Alchemy (Ethereum Mainnet)
   ```

3. Contratos principais:

   * **LendingPool**: `0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9`
   * **DAI**: `0x6B175474E89094C44Da98b954EedeAC495271d0F`
   * **Exploit**: contrato local implementando `IFlashLoanReceiver`

---

## 🔹 Execução

Logs do teste:

```
=== Starting Aave oracle manipulation test ===
DAI balance before attack: 1000000000000000000000
Received flashloan amount: 1000000000000000000000000
Premium (fee) to repay: 900000000000000000000
DAI balance after attack: 100000000000000000000
=== Finished Aave oracle manipulation test ===
```

* Saldo inicial: **1,000 DAI**
* Flashloan recebido: **1,000,000 DAI**
* Taxa (premium): **900 DAI**
* Saldo final: **100 DAI**

---

## 🔹 Análise

* O contrato **recebeu e devolveu** corretamente o empréstimo + taxa.
* Sobrou **100 DAI** como evidência de execução do fluxo.
* O `executeOperation` foi chamado pela Aave Pool e logou os valores esperados.

---

## 🔹 Conclusão

* ✅ **Validação completa do esqueleto de exploit com Aave**
* Agora é possível:

  * Integrar manipulação de oráculos (Curve, Uniswap, etc.)
  * Simular liquidações incorretas
  * Testar cenários de dreno de liquidez

---

> “Um flashloan sem payload é só um empréstimo caro; a exploração começa quando mexemos no preço ou no colateral.”

```

