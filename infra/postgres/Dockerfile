# Postgres 16 with PostGIS and h3 — the extension set the migrations need. The stock
# postgis/postgis image has no h3, so neither CI nor compose can use it as-is.
FROM postgis/postgis:16-3.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-h3 \
 && rm -rf /var/lib/apt/lists/*
