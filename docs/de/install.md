<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <strong>Deutsch</strong> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# Installationsanleitung

> 🌐 Diese Anleitung wurde maschinell übersetzt. Für die genauesten Informationen siehe die [englische](../en/install.md) oder [koreanische](../ko/install.md) Version.

Kei-Risu kann auf vier Arten installiert werden.

- [1. Portable-Paket](#1-portable-paket) — Vorkompilierte Binärdatei. Kein Node.js erforderlich.
- [2. Docker](#2-docker) — Container-Umgebung.
- [3. Installationsskript](#3-installationsskript) — Automatischer Build aus dem Quellcode. Für Linux/macOS-Server.
- [4. Git Clone](#4-git-clone) — Manueller Quellbuild. Für Entwickler / fortgeschrittene Benutzer.


## Systemanforderungen

| Element     | Minimum              | Empfohlen                                  |
| ----------- | -------------------- | ------------------------------------------ |
| **CPU**     | 1 Kern               | 2+ Kerne                                   |
| **RAM**     | 1 GB (nur Ausführen) | 4+ GB (inkl. Build)                        |
| **Disk**    | 1 GB                 | 2+ GB                                      |
| **Node.js** | 22.12+               | (nicht erforderlich für Portable/Docker)   |

Das Portable-Paket und Docker benötigen keinen Build-Schritt und können mit 1 GB RAM laufen. Direkte Builds (Git Clone, Installationsskript) verbrauchen während des Builds viel Speicher; 4 GB oder mehr werden empfohlen.


---

## 1. Portable-Paket

Laden Sie eine vorkompilierte Binärdatei herunter und führen Sie sie aus. Kein Node.js, Docker oder andere Tools erforderlich. Unterstützt Windows, macOS (Apple Silicon) und Linux (x64/ARM).

### Download

Holen Sie die Datei für Ihr OS von der [Releases-Seite](https://github.com/tegy1117/Kei-Risu/releases).

| OS                      | Datei                                     |
| ----------------------- | ----------------------------------------- |
| Windows (x64)           | `Kei-Risu-vX.X.X-win-x64.zip`           |
| macOS (Apple Silicon)   | `Kei-Risu-vX.X.X-macos-arm64.tar.gz`    |
| Linux (x64)             | `Kei-Risu-vX.X.X-linux-x64.tar.gz`      |
| Linux (ARM)             | `Kei-Risu-vX.X.X-linux-arm64.tar.gz`    |

### Ausführen

**Windows**

Entpacken Sie die zip und doppelklicken Sie auf `Kei-Risu.exe`. Ein Browser öffnet sich automatisch unter `http://localhost:6001`.

**macOS**

```bash
tar -xzf Kei-Risu-vX.X.X-macos-arm64.tar.gz
xattr -cr Kei-Risu-vX.X.X-macos-arm64
open Kei-Risu-vX.X.X-macos-arm64/Kei-Risu.app
```

Der `xattr`-Befehl ist ein einmaliger Schritt, um die "Apple kann nicht verifizieren"-Warnung zu umgehen.

**Linux**

```bash
tar -xzf Kei-Risu-vX.X.X-linux-*.tar.gz
cd Kei-Risu-vX.X.X-linux-*
./start.sh
```

Öffnen Sie `http://localhost:6001` in Ihrem Browser.

### Headless-Server (Ein-Zeilen-Download)

Für Linux/macOS-Server ohne GUI: Neueste Version in einem Befehl herunterladen und ausführen.

**Linux (x64):**

```bash
VERSION=$(curl -s https://api.github.com/repos/tegy1117/Kei-Risu/releases/latest | grep -o '"tag_name":"[^"]*"' | cut -d'"' -f4)
curl -fsSL "https://github.com/tegy1117/Kei-Risu/releases/download/${VERSION}/Kei-Risu-${VERSION}-linux-x64.tar.gz" -o kei-risu.tar.gz
tar -xzf kei-risu.tar.gz && rm kei-risu.tar.gz
cd Kei-Risu-${VERSION}-linux-x64
./start.sh
```

**Linux (ARM):** Ersetzen Sie `linux-x64` durch `linux-arm64` im obigen Befehl.

**macOS (Apple Silicon):**

```bash
VERSION=$(curl -s https://api.github.com/repos/tegy1117/Kei-Risu/releases/latest | grep -o '"tag_name":"[^"]*"' | cut -d'"' -f4)
curl -fsSL "https://github.com/tegy1117/Kei-Risu/releases/download/${VERSION}/Kei-Risu-${VERSION}-macos-arm64.tar.gz" -o kei-risu.tar.gz
tar -xzf kei-risu.tar.gz && rm kei-risu.tar.gz
xattr -cr Kei-Risu-${VERSION}-macos-arm64
cd Kei-Risu-${VERSION}-macos-arm64
./start.sh
```

### Aktualisieren

Klicken Sie auf "Jetzt aktualisieren" im Update-Popup auf dem Startbildschirm der Web-UI, oder führen Sie das Update-Skript im Installationsordner aus.

- **Windows**: Doppelklick auf `update.bat`
- **macOS / Linux**: `./update.sh`

Daten im `save/`-Ordner bleiben erhalten.


---

## 2. Docker

Läuft auf einem System mit installiertem Docker oder Docker Desktop.

### Docker installieren

- **Windows / macOS**: Installieren Sie [Docker Desktop](https://www.docker.com/products/docker-desktop/).
- **Linux**:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

### Ausführen

```bash
curl -L https://raw.githubusercontent.com/tegy1117/Kei-Risu/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

Öffnen Sie `http://localhost:6001` in Ihrem Browser.

### Aktualisieren

```bash
docker compose pull && docker compose up -d
```

### Datenstandort

Alle Daten (Chats, Charaktere usw.) werden im Docker-Volume `risuai-save` gespeichert. Daten bleiben bei Updates erhalten.


---

## 3. Installationsskript

Holt den Quellcode und baut automatisch mit Node.js. Läuft auf Linux/macOS-Servern. Verwenden Sie dies, wenn Sie Updates über `git pull` verwalten möchten.

### Voraussetzungen

Node.js 22.12 oder höher ist erforderlich:

```bash
node --version
# v22.12.0 oder höher
```

Installieren Sie von der [offiziellen Node.js-Website](https://nodejs.org/), falls nicht vorhanden.

### Installieren

```bash
curl -fsSL https://raw.githubusercontent.com/tegy1117/Kei-Risu/main/install.sh | bash
```

Eine Statusmeldung wird angezeigt, wenn die Installation abgeschlossen ist.

### Server starten

```bash
cd ~/kei-risu
pnpm runserver
```

Öffnen Sie `http://localhost:6001` in Ihrem Browser.

### Aktualisieren

```bash
cd ~/kei-risu
./update.sh
```

> **Einmalige PocketRisu-Migration**: Wenn Ihre bestehende Installation von PocketRisu stammt, ersetzen Sie `update.sh` einmal vor dem Update. Das alte Skript lädt weiterhin aus dem PocketRisu-Repository.
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/tegy1117/Kei-Risu/main/update.sh -o update.sh && chmod +x update.sh
> ./update.sh
> ```
>
> Nachfolgende Updates laufen wie gewohnt mit `./update.sh`.


---

## 4. Git Clone

Manuelles Klonen und Bauen des Quellcodes. Für Entwickler, die Code ändern oder debuggen müssen.

```bash
git clone https://github.com/tegy1117/Kei-Risu.git
cd Kei-Risu
pnpm install
pnpm build
pnpm runserver
```

Öffnen Sie `http://localhost:6001` in Ihrem Browser.

### Aktualisieren

```bash
git pull
pnpm install
pnpm build
# Server neu starten
pnpm runserver
```


---

← [Zurück zur README](../../i18n/README.de.md)
