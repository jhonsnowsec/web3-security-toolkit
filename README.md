# 🐺 Bug Bounty Machine – Guia Definitivo

## 📌 Contexto

* Projeto: **web3-security-toolkit / bounty-pocs**
* Objetivo: Criar uma **máquina de caçar bug bounties** em protocolos DeFi/Web3
* Ferramentas principais: Foundry, Anvil, Cast, Python, Bash, GitHub Actions

---

# 🔹 Setup Completo

## 1. Instalação do ambiente

```bash
# Instalação via Homebrew (macOS) ou gerenciador de pacotes equivalente
brew install foundry rust node jq coreutils python3 git gnu-sed

# Atualiza o Foundry para a última versão
foundryup

# Instala a dependência Python para o pipeline de recon
pip3 install pyyaml
````

  * `forge` → compila e testa contratos.
  * `anvil` → simula blockchains locais (forking).
  * `cast` → interage com a blockchain via linha de comando.

### 2\. Configuração de RPCs e Chaves de API (`.env`)

Crie um arquivo `.env` na raiz para armazenar suas chaves privadas. Este arquivo é ignorado pelo Git para sua segurança.

```ini
# ==== RPC URLs (obrigatório para forking) ====
RPC_MAINNET=https://eth-mainnet.g.alchemy.com/v2/SUA_API_KEY
RPC_OPTIMISM=https://opt-mainnet.g.alchemy.com/v2/SUA_API_KEY
RPC_ARBITRUM=https://arb-mainnet.g.alchemy.com/v2/SUA_API_KEY

# ==== API Keys (opcional) ====
ETHERSCAN_API_KEY=
POLYGONSCAN_API_KEY=
ARBISCAN_API_KEY=
```

Carregar variáveis:

```bash
source .env
```

---

## 9. Exploits e Testes

* Criar exploits em `src/targets/`
* Testes em `test/targets/` com `Exploit.t.sol`
* Rodar com:

```bash
forge test --fork-url $RPC_MAINNET --fork-block-number <BLOCK> -vvvv
```

---

## 10. Próximos Passos

* Corrigir endereços de targets no Alchemix
* Expandir exploit no Curve com `deal()` para seed de DAI/USDC/USDT
* Testar Wormhole com verificação de assinaturas/replays
* Integrar geração automática de relatórios

---

# 🚀 Comandos Rápidos

```bash
# Recon pipeline
make recon

# Fork mainnet em bloco específico
forge test --fork-url $RPC_MAINNET --fork-block-number <BLOCK> -vvvv

# Rodar só Curve
forge test -vvvv --match-path test/targets/curve/Exploit.t.sol
```

---


> “Cada linha de código tem um preço — encontre antes que outro ache.”

---
