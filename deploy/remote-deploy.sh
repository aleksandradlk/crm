#!/usr/bin/env bash
# ============================================================
# Auslieferung auf dem Server – wird von GitHub Actions per SSH gestartet
# (siehe .github/workflows/deploy.yml), kann aber auch von Hand laufen.
#
# Ablauf:
#   1. neuen Stand einspielen (git, falls der Server ein Git-Klon mit Zugriff
#      auf GitHub ist – sonst aus dem mitgeschickten Archiv)
#   2. npm install, pm2 neu starten
#   3. Gesundheits-Check /api/health – schlägt er fehl, wird automatisch der
#      vorherige Stand wiederhergestellt
#
# Unangetastet bleiben: backend/.env, node_modules, hochgeladene Dateien
# (~/uploads) und alles andere, was nicht im Git liegt.
#
# Variablen: APP_DIR (Pflicht), SHA (Pflicht), ARCHIVE (Pfad zum .tgz),
#            PM2_NAME (Standard: leadhunter)
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:?APP_DIR fehlt}"
SHA="${SHA:?SHA fehlt}"
ARCHIVE="${ARCHIVE:-}"
PM2_NAME="${PM2_NAME:-leadhunter}"
# "~/crm" oder "crm" (relativ) beziehen sich auf das Home-Verzeichnis
case "$APP_DIR" in "~") APP_DIR="$HOME" ;; "~/"*) APP_DIR="$HOME/${APP_DIR#\~/}" ;; /*) ;; *) APP_DIR="$HOME/$APP_DIR" ;; esac
# Relativer Archiv-Pfad bezieht sich auf das Home-Verzeichnis (dorthin lädt GitHub Actions hoch)
case "$ARCHIVE" in /*|'') ;; *) ARCHIVE="$HOME/$ARCHIVE" ;; esac

log()  { echo "▶ $*"; }
warn() { echo "⚠ $*"; }
fail() { echo "✖ $*" >&2; exit 1; }

# Node, npm und pm2 auch in nicht-interaktiven SSH-Sitzungen finden
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true; fi
for d in "$HOME/.npm-global/bin" "$HOME/bin" "$HOME/.local/bin" /opt/plesk/node/*/bin /usr/local/bin; do
  if [ -d "$d" ]; then PATH="$d:$PATH"; fi
done
export PATH
command -v node >/dev/null || fail "node wurde auf dem Server nicht gefunden"
command -v npm  >/dev/null || fail "npm wurde auf dem Server nicht gefunden"
# Global installierte npm-Programme (pm2) liegen im Präfix von npm
NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
if [ -d "$NPM_BIN" ]; then PATH="$NPM_BIN:$PATH"; fi
command -v pm2  >/dev/null || fail "pm2 wurde auf dem Server nicht gefunden (npm install -g pm2)"

cd "$APP_DIR" || fail "Ordner $APP_DIR gibt es auf dem Server nicht"
[ -f backend/package.json ] || fail "$APP_DIR ist nicht der CRM-Ordner (backend/package.json fehlt)"
[ -f backend/.env ] || fail "backend/.env fehlt in $APP_DIR"

PORT="$(grep -E '^[[:space:]]*PORT=' backend/.env | tail -n1 | cut -d= -f2- | tr -d '"'"'"' \r')"
PORT="${PORT:-3000}"

# ── 1. Neuen Stand einspielen ────────────────────────────────
MODE=archive
if [ -d .git ] && git fetch -q origin 2>/dev/null && git cat-file -e "$SHA^{commit}" 2>/dev/null; then
  MODE=git
fi

if [ "$MODE" = git ]; then
  PREV="$(git rev-parse HEAD)"
  log "Git: $(git rev-parse --short HEAD) → $(git rev-parse --short "$SHA")"
  # --keep bricht ab, statt lokale Änderungen auf dem Server zu überschreiben
  git reset -q --keep "$SHA" || fail "Auf dem Server gibt es lokale Änderungen an Projektdateien – bitte prüfen (git status)"
  rollback() { git reset -q --keep "$PREV"; }
else
  [ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || fail "Kein Archiv zum Einspielen gefunden ($ARCHIVE)"
  [ -d .git ] && warn "Server-Ordner ist ein Git-Klon ohne GitHub-Zugriff – spiele Archiv ein"
  BACKUP="$HOME/.crm-deploy-backup.tgz"
  tar -tzf "$ARCHIVE" | grep -v '/$' > "$HOME/.crm-deploy-files" || true
  # Bisherige Fassung der Dateien sichern, die gleich überschrieben werden
  tar -czf "$BACKUP" --ignore-failed-read -T "$HOME/.crm-deploy-files" 2>/dev/null || true
  log "Archiv: $(cat .deployed-sha 2>/dev/null | cut -c1-7 || echo '?') → ${SHA:0:7}"
  tar -xzf "$ARCHIVE"
  rollback() { [ -s "$BACKUP" ] && tar -xzf "$BACKUP"; }
fi
OLD_SHA="$(cat .deployed-sha 2>/dev/null || true)"
echo "$SHA" > .deployed-sha

# ── 2. Abhängigkeiten + Neustart ─────────────────────────────
install_and_restart() {
  (cd backend && npm install --omit=dev --no-audit --no-fund --loglevel=error)
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    pm2 restart "$PM2_NAME" --update-env >/dev/null
  else
    (cd backend && pm2 start server.js --name "$PM2_NAME" >/dev/null)
  fi
  pm2 save >/dev/null 2>&1 || true
}

healthy() {
  # Server startet erst nach den Datenbank-Migrationen → bis zu 90 Sekunden warten
  for _ in $(seq 1 45); do
    if node -e "fetch('http://127.0.0.1:' + process.argv[1] + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$PORT"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

log "npm install + pm2 restart ($PM2_NAME)"
install_and_restart

# ── 3. Gesundheits-Check, sonst zurück auf den alten Stand ───
log "Gesundheits-Check auf Port $PORT"
if healthy; then
  log "Fertig: ${SHA:0:7} läuft"
  rm -f "$ARCHIVE" 2>/dev/null || true
  exit 0
fi

echo "✖ Neuer Stand startet nicht – letzte Log-Zeilen:" >&2
pm2 logs "$PM2_NAME" --lines 40 --nostream 2>&1 | tail -n 40 >&2 || true
warn "Stelle vorherigen Stand wieder her"
rollback
echo "$OLD_SHA" > .deployed-sha
install_and_restart
if healthy; then warn "Vorheriger Stand läuft wieder"; else echo "✖ Auch der vorherige Stand startet nicht – bitte sofort prüfen!" >&2; fi
exit 1
