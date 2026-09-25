#!/usr/bin/env bash
# Prueba las migraciones en un Postgres local:  PGHOST=/tmp/pg PGPORT=5433 ./supabase/tests/ejecutar.sh
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -U ${PGUSER:-postgres} -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists gofio_test" -c "create database gofio_test"
for f in tests/_stub_supabase.sql migrations/*.sql tests/pruebas.sql; do $P -d gofio_test -f "$f"; done
