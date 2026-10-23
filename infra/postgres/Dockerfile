# Postgres 16 with PostGIS and h3 — the extension set the migrations need.
#
# Built on the official postgres image, pinned to a Debian release, with both extensions from
# the PostgreSQL apt repository (PGDG) that image already trusts.
#
# Was `FROM postgis/postgis:16-3.5`. That tag is built on Debian bullseye, and PGDG stopped
# serving bullseye: `apt-get update` failed with "bullseye-pgdg Release does not have a Release
# file", so this image could not be built and every CI database job since 1 October 2026 failed
# before a single migration ran. Pinning the release (bookworm) keeps a base-image refresh from
# changing the distribution underneath us again.
FROM postgres:16-bookworm
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends \
      postgresql-16-postgis-3 \
      postgresql-16-postgis-3-scripts \
      postgresql-16-h3 \
 && rm -rf /var/lib/apt/lists/*
