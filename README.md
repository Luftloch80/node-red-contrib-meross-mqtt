# node-red-contrib-meross-mqtt

Node-RED-Nodes zum Auslesen von **Meross-Steckdosen mit Strommessung** (z. B. MSS310, MSS305, MSS315)
– Leistung, Spannung, Strom, Tagesverbrauch und Schaltzustand. Die Steckdose kann außerdem geschaltet werden.

Drei Verbindungsarten werden unterstützt:

| Modus | Beschreibung | Benötigt |
|---|---|---|
| **Meross Cloud (MQTT)** | Login mit dem Meross-Konto, Kommunikation über den Cloud-MQTT-Broker | E-Mail, Passwort, Region |
| **Lokaler MQTT-Broker** | Für Geräte, die mit einem eigenen Broker (z. B. Mosquitto) gekoppelt sind | Broker-URL, Geräte-Key |
| **Lokal HTTP** | Direkte Abfrage per `http://<IP>/config` im LAN | Geräte-Key, IP je Gerät |

## Installation

Im Node-RED-Benutzerverzeichnis (meist `~/.node-red`):

```sh
npm install /pfad/zu/node-red-contrib-meross-mqtt
# oder direkt aus GitHub
npm install github:luftloch80/node-red-contrib-meross-mqtt
```

Danach Node-RED neu starten. Voraussetzung: Node.js ≥ 18, Node-RED ≥ 3.

## Nodes

### `meross-config` (Konfiguration)

Legt die Verbindung fest. Zugangsdaten werden als Node-RED-Credentials verschlüsselt gespeichert.
Cloud-Logins werden im Speicher zwischengespeichert, damit nicht bei jedem Deploy neu eingeloggt wird.

### `meross plug`

- **Connection** – die Konfiguration von oben
- **Devices / Device UUID** – im Cloud-Modus nach dem ersten Deploy per Refresh-Button auswählbar,
  sonst UUID manuell eintragen (steht u. a. in der Meross-App unter Geräteinfo)
- **IP / host** – nur im HTTP-Modus
- **Channel** – Kanal (bei Einzelsteckdosen `0`)
- **Poll (s)** – Abfrageintervall, `0` = nur bei eingehender Nachricht
- Auswahl, welche Daten gelesen werden: Leistung/Spannung/Strom, Verbrauch, Schaltzustand

#### Ausgabe

```json
{
  "power": 115.25,
  "voltage": 230.4,
  "current": 0.523,
  "onoff": true,
  "energyToday": 42,
  "consumption": [{ "date": "2026-09-24", "energy": 310, "timestamp": 1790000000 }],
  "channel": 0,
  "timestamp": 1790200000000
}
```

Einheiten: `power` W, `voltage` V, `current` A, `energyToday`/`energy` Wh.

`msg.topic` ist der Node-Name (oder die UUID). Meldet das Gerät eine Zustandsänderung (Push über MQTT),
wird eine Nachricht mit `msg.event = "push"` ausgegeben.

#### Eingabe

| `msg.payload` | Wirkung |
|---|---|
| beliebig | Werte sofort auslesen |
| `true`, `"on"`, `1` | einschalten, dann auslesen |
| `false`, `"off"`, `0` | ausschalten, dann auslesen |
| `"toggle"` | umschalten, dann auslesen |

Für eigene Abfragen kann `msg.namespace` gesetzt werden (z. B. `Appliance.System.All`),
optional mit `msg.method` (Standard `GET`) und `msg.payload` als Anfrage-Payload.
Die Antwort landet in `msg.payload`.

## Beispiel

Unter *Import → Examples → node-red-contrib-meross-mqtt* gibt es den Flow `power-monitor`.

## Protokoll-Details

Meross-Geräte sprechen JSON mit einem Header (`messageId`, `namespace`, `method`, `timestamp`, `sign`).
Die Signatur ist `md5(messageId + key + timestamp)`. Verwendete Namespaces:

- `Appliance.Control.Electricity` – aktuelle Leistung (mW), Spannung (dV), Strom (mA)
- `Appliance.Control.ConsumptionX` (bzw. `Appliance.Control.Consumption`) – Tagesverbrauch in Wh
- `Appliance.System.All` – Schaltzustand
- `Appliance.Control.ToggleX` (bzw. `Appliance.Control.Toggle`) – Schalten

Per MQTT werden Anfragen auf `/appliance/<uuid>/subscribe` veröffentlicht; das Gerät antwortet auf dem Topic
aus `header.from`, Push-Meldungen kommen auf `/appliance/<uuid>/publish` (lokal) bzw. `/app/<userId>/subscribe` (Cloud).

## Hinweise

- **Geräte-Key**: Bei Cloud-gekoppelten Geräten ist das der `key` des Meross-Kontos (wird beim Cloud-Login geliefert).
  Bei Geräten, die ohne Key an einen eigenen Broker gekoppelt wurden, bleibt das Feld leer.
- **Rate-Limit**: Die Meross-Cloud drosselt zu häufige Anfragen. Im Cloud-Modus ein Intervall von mindestens 10–30 s wählen.
- **Konten mit 2-Faktor-Authentifizierung** werden derzeit nicht unterstützt.
- Einige neuere Firmware-Versionen verschlüsseln die lokale HTTP-API; dann bitte den MQTT- oder Cloud-Modus verwenden.
- Die Meross-Cloud verteilt Geräte auf mehrere MQTT-Broker (`mqtt-eu-1.meross.com`, `mqtt-eu-2.meross.com`, …).
  Im Cloud-Modus wird der Broker jedes Geräts aus der Geräteliste übernommen. *MQTT host* überschreibt das für alle Geräte.

## Fehlersuche

Antwortet eine Steckdose nicht (`Timeout waiting for ...`), in der Verbindung **Log all messages** aktivieren,
deployen und auf dem Pi `node-red-log` aufrufen. Dort stehen die Geräteliste (UUID, Broker, online) sowie alle
gesendeten (`->`) und empfangenen (`<-`) Nachrichten.

## Entwicklung

```sh
npm install
npm test
```

Die Tests simulieren eine Steckdose sowohl per HTTP als auch über einen lokalen MQTT-Broker (aedes)
und prüfen den Cloud-Login gegen einen Mock-Server.

## Lizenz

MIT
