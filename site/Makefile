# Convenience targets for local development.
#
# The firmware page uses a self-hosted, patched esp-web-tools bundle that is
# generated (not committed) by scripts/build-esp-web-tools.sh. These targets
# make sure it is built before Hugo runs.

.PHONY: serve build vendor vendor-force clean

# Build the patched esp-web-tools bundle (skips if already up to date).
vendor:
	./scripts/build-esp-web-tools.sh

# Force a rebuild (e.g. after updating the esptool-js fork).
vendor-force:
	FORCE_REBUILD=1 ./scripts/build-esp-web-tools.sh

# Run the local dev server (Web Serial works on http://localhost).
serve: vendor
	hugo server

# Produce the production build into ./public.
build: vendor
	hugo --minify

clean:
	rm -rf static/vendor public
