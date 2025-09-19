#!/usr/bin/env python3
"""
gen_report.py - Gera um resumo legível em Markdown dos alvos monitorados
Entrada: arquivos JSON (ex: targets.enriched.json)
Saída: stdout (redirecionar para reports/recon-summary.md)
"""

import json
import sys
import datetime
from pathlib import Path

def load_json(file_path):
    try:
        with open(file_path) as fh:
            return json.load(fh)
    except Exception as e:
        print(f"⚠️ Erro lendo {file_path}: {e}", file=sys.stderr)
        return []

def main():
    if len(sys.argv) < 2:
        print("Uso: gen_report.py <arquivo1.json> [arquivo2.json ...]")
        sys.exit(1)

    all_targets = []
    for f in sys.argv[1:]:
        if Path(f).is_file():
            data = load_json(f)
            if isinstance(data, list):
                all_targets.extend(data)
            elif isinstance(data, dict):
                # se tiver chave "targets", pega a lista
                if "targets" in data and isinstance(data["targets"], list):
                    all_targets.extend(data["targets"])
                else:
                    all_targets.append(data)

    now = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"# Recon Summary\n\n_Last update: {now}_\n")

    if not all_targets:
        print("Nenhum alvo encontrado nos JSONs fornecidos.")
        return

    for t in all_targets:
        name = t.get("name", "Unknown")
        tvl = t.get("tvl_usd", "n/a")
        url = t.get("bounty_url", "n/a")
        audit = t.get("last_audit", "n/a")
        chain = t.get("chain", "n/a")

        # formatação de TVL
        if isinstance(tvl, (int, float)):
            tvl_fmt = f"${tvl:,.0f}"
        else:
            tvl_fmt = str(tvl)

        print(f"## {name}")
        print(f"- Chain: {chain}")
        print(f"- TVL: {tvl_fmt}")
        print(f"- Bounty: {url}")
        print(f"- Last audit: {audit}\n")

if __name__ == "__main__":
    main()
