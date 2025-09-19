#!/usr/bin/env python3
"""
Enhanced TVL Refresh Script
Pulls real-time TVL data from DeFiLlama API
"""

import json
import sys
import time
import datetime
import yaml
import urllib.request
from pathlib import Path

# DefiLlama API endpoints
DEFILLAMA_BASE = "https://api.llama.fi"
PROTOCOLS_ENDPOINT = f"{DEFILLAMA_BASE}/protocols"

# Protocol name mappings (targets.yml name -> DeFiLlama slug)
PROTOCOL_MAPPING = {
    "Aave": "aave",
    "Curve": "curve-dex",
    "Wormhole": "wormhole",
    "Arbitrum": "arbitrum",
    "Lido": "lido",
    "MakerDAO": "makerdao",
    "Compound": "compound",
    "Uniswap": "uniswap",
    "Optimism": "optimism",
    "Base": "base",
    "EigenLayer": "eigenlayer",
    "Pendle": "pendle",
    "Blast": "blast"
}

def fetch_tvl_data():
    """Fetch current TVL data from DeFiLlama"""
    try:
        with urllib.request.urlopen(PROTOCOLS_ENDPOINT, timeout=30) as response:
            data = json.loads(response.read().decode())
            
        # Create lookup dict by slug
        tvl_lookup = {}
        for protocol in data:
            slug = protocol.get("slug", "")
            tvl = protocol.get("tvl", 0)
            tvl_lookup[slug] = tvl
            
        return tvl_lookup
    except Exception as e:
        print(f"[WARN] Failed to fetch TVL data: {e}", file=sys.stderr)
        return {}

def calculate_priority(tvl_usd, max_bounty_usd=0):
    """
    Calculate priority based on TVL and max bounty
    
    Priority scoring:
    - CRITICAL: TVL > $10B OR max_bounty >= $10M
    - HIGH: TVL > $1B OR max_bounty >= $2M
    - MEDIUM: TVL > $100M OR max_bounty >= $1M
    - LOW: Everything else
    """
    if tvl_usd >= 10_000_000_000 or max_bounty_usd >= 10_000_000:
        return "CRITICAL"
    elif tvl_usd >= 1_000_000_000 or max_bounty_usd >= 2_000_000:
        return "HIGH"
    elif tvl_usd >= 100_000_000 or max_bounty_usd >= 1_000_000:
        return "MEDIUM"
    else:
        return "LOW"

def format_number(n):
    """Format large numbers for readability"""
    if n >= 1_000_000_000:
        return f"${n/1_000_000_000:.2f}B"
    elif n >= 1_000_000:
        return f"${n/1_000_000:.2f}M"
    elif n >= 1_000:
        return f"${n/1_000:.2f}K"
    return f"${n:.2f}"

def main():
    if len(sys.argv) != 3:
        print("Usage: refresh-tvl-enhanced.py <targets.yml> <output.json>", file=sys.stderr)
        sys.exit(1)
    
    targets_file = Path(sys.argv[1])
    output_file = Path(sys.argv[2])
    
    # Load targets
    with open(targets_file, "r", encoding="utf-8") as f:
        targets = yaml.safe_load(f) or []
    
    # Fetch live TVL data
    print("[*] Fetching live TVL data from DeFiLlama...", file=sys.stderr)
    tvl_data = fetch_tvl_data()
    
    # Enrich targets with live data
    enriched = []
    stats = {
        "total_tvl": 0,
        "total_max_bounty": 0,
        "count_by_priority": {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0},
        "count_by_chain": {},
    }
    
    for target in targets:
        name = target.get("name", "")
        
        # Try to get live TVL
        if name in PROTOCOL_MAPPING:
            slug = PROTOCOL_MAPPING[name]
            live_tvl = tvl_data.get(slug, 0)
            if live_tvl > 0:
                old_tvl = target.get("tvl_usd", 0)
                target["tvl_usd"] = live_tvl
                target["tvl_source"] = "defillama_api"
                target["tvl_updated_at"] = datetime.datetime.utcnow().isoformat()
                
                # Calculate TVL change
                if old_tvl > 0:
                    change_pct = ((live_tvl - old_tvl) / old_tvl) * 100
                    target["tvl_change_pct"] = round(change_pct, 2)
                    target["tvl_change_formatted"] = f"{'+' if change_pct > 0 else ''}{change_pct:.1f}%"
        
        # Calculate priority
        tvl = target.get("tvl_usd", 0)
        max_bounty = target.get("max_bounty_usd", 0)
        priority = calculate_priority(tvl, max_bounty)
        target["priority"] = priority
        
        # Add formatted values
        target["tvl_formatted"] = format_number(tvl)
        target["max_bounty_formatted"] = format_number(max_bounty)
        
        # Risk score (0-100)
        risk_score = 0
        if "attack_vectors" in target:
            risk_score += len(target["attack_vectors"]) * 10
        if tvl > 1_000_000_000:
            risk_score += 20
        if max_bounty >= 10_000_000:
            risk_score += 30
        if "last_audit" in target:
            # Penalize if audit is old
            audit_date = target["last_audit"]
            if "2023" in audit_date or "2022" in audit_date:
                risk_score += 15
        target["risk_score"] = min(risk_score, 100)
        
        # Update stats
        stats["total_tvl"] += tvl
        stats["total_max_bounty"] += max_bounty
        stats["count_by_priority"][priority] += 1
        
        chain = target.get("chain", "unknown")
        stats["count_by_chain"][chain] = stats["count_by_chain"].get(chain, 0) + 1
        
        enriched.append(target)
    
    # Sort by priority and TVL
    priority_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    enriched.sort(key=lambda x: (
        priority_order.get(x["priority"], 999),
        -x.get("tvl_usd", 0)
    ))
    
    # Build final output
    now = int(time.time())
    output = {
        "generated_at": now,
        "generated_at_iso": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(),
        "stats": {
            "count_targets": len(enriched),
            "count_critical": stats["count_by_priority"]["CRITICAL"],
            "count_high": stats["count_by_priority"]["HIGH"],
            "count_medium": stats["count_by_priority"]["MEDIUM"],
            "count_low": stats["count_by_priority"]["LOW"],
            "total_tvl_usd": stats["total_tvl"],
            "total_tvl_formatted": format_number(stats["total_tvl"]),
            "total_max_bounty_usd": stats["total_max_bounty"],
            "total_max_bounty_formatted": format_number(stats["total_max_bounty"]),
            "chains": stats["count_by_chain"],
            "top_3_by_tvl": [t["name"] for t in enriched[:3]],
            "top_3_by_bounty": sorted(enriched, key=lambda x: -x.get("max_bounty_usd", 0))[:3]
        },
        "targets": enriched
    }
    
    # Write output
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    # Print summary
    print(f"""
╔═══════════════════════════════════════════════════╗
║           TVL REFRESH COMPLETE                    ║
╠═══════════════════════════════════════════════════╣
║ Targets Processed: {len(enriched):>31} ║
║ Live TVL Updates:  {len([t for t in enriched if t.get("tvl_source") == "defillama_api"]):>31} ║
║ Total TVL:         {format_number(stats["total_tvl"]):>31} ║
║ Total Bounties:    {format_number(stats["total_max_bounty"]):>31} ║
╠═══════════════════════════════════════════════════╣
║ Priority Breakdown:                               ║
║   CRITICAL: {stats["count_by_priority"]["CRITICAL"]:>37} ║
║   HIGH:     {stats["count_by_priority"]["HIGH"]:>37} ║
║   MEDIUM:   {stats["count_by_priority"]["MEDIUM"]:>37} ║
║   LOW:      {stats["count_by_priority"]["LOW"]:>37} ║
╠═══════════════════════════════════════════════════╣
║ Top 3 Targets by TVL:                            ║
""", file=sys.stderr, end="")
    
    for t in enriched[:3]:
        print(f"║   • {t['name']:<20} {t['tvl_formatted']:>24} ║", file=sys.stderr)
    
    print(f"""╠═══════════════════════════════════════════════════╣
║ Top 3 Bounties:                                   ║""", file=sys.stderr, end="")
    
    for t in sorted(enriched, key=lambda x: -x.get("max_bounty_usd", 0))[:3]:
        print(f"""
║   • {t['name']:<20} {t.get('max_bounty_formatted', 'N/A'):>24} ║""", file=sys.stderr, end="")
    
    print(f"""
╚═══════════════════════════════════════════════════╝
    
[✓] Output written to {output_file}
    """, file=sys.stderr)

if __name__ == "__main__":
    main()