# Build the recovery catalog from the firmware images available locally.
.PHONY: serve build recovery-catalog clean

recovery-catalog:
	python3 scripts/build-recovery-catalog.py

serve: recovery-catalog
	hugo server

build: recovery-catalog
	hugo --minify

clean:
	rm -rf public
	rm -f static/recovery-flasher/firmware.json
