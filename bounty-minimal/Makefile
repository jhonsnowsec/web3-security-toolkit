recon:
	@echo "[*] Refreshing TVL with live data..."
	python3 bounty-pocs/recon/scripts/refresh-tvl-enhanced.py \
		bounty-pocs/recon/targets.yml \
		bounty-pocs/recon/targets.enriched.json
	@echo "[*] Fetching programs..."
	PYTHONPATH=bounty-pocs/recon/scripts bash bounty-pocs/recon/scripts/fetch-programs.sh
