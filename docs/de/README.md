# Govee Smart

Steuert Govee-WLAN-Geräte aus ioBroker: LED-Streifen, Lampen und Panels, Thermo- und Hygrometer,
Luftgüte-Monitore, Steckdosen, Batterie-Taster und Fernbedienungen sowie Geräte wie Heizer,
Luftbefeuchter, Duftspender, Wasserkocher, Eiswürfelbereiter, Ventilatoren und Luftreiniger.

Der Adapter spricht mit deinen Geräten **lokal, wann immer es geht**. Eine Lampe mit aktivierter
lokaler Schnittstelle antwortet im eigenen Netz in Millisekunden, und die Cloud darf niemals
überschreiben, was das Gerät gerade lokal gemeldet hat. Die Cloud liefert nur, was sie allein
weiß — Gerätenamen, Fähigkeiten, Szenen und Snapshots — und übernimmt die Steuerung für Geräte
ohne lokale Schnittstelle.

## Was du bekommst, je nachdem was du einträgst

Alles ist freiwillig: ohne Eintrag findet und schaltet der Adapter die Lampen im eigenen Netz lokal;
ein kostenloser Govee-API-Schlüssel bringt Namen, Fähigkeiten, Szenen, Snapshots und Segmente; das
Govee-Konto bringt Echtzeit-Status — was jede Stufe im Einzelnen bringt, steht auf der Wiki-Seite
[Einrichtung](https://github.com/krobipd/ioBroker.govee-smart/wiki/Einrichtung).

**Die lokale Schnittstelle muss je Gerät in der Govee-Home-App eingeschaltet werden**
(Geräte-Einstellungen → LAN Control). Ohne sie läuft das Gerät über die Cloud — das funktioniert,
dauert aber einige Sekunden je Befehl und ist von Govee mengenmäßig begrenzt.

## Einrichten

1. Adapter installieren und eine Instanz anlegen.
2. Die Instanz-Einstellungen öffnen. Die Karte **Verbindung** führt durch die drei Stufen oben und
   sagt, was läuft und was nicht — samt Anmelde-Test, der sich wirklich anmeldet und nicht nur das
   Formular prüft.
3. Verlangt Govee einen Bestätigungscode (das tut es bei einem neuen Client), fragt die Karte
   danach. Mehr ist nicht nötig: der Adapter merkt sich die Anmeldung über Neustarts hinweg, es
   werden also keine weiteren Codes verschickt.
4. Geräte erscheinen unter `devices.<modell>-<kennung>` — das Modell und die letzten vier Zeichen
   der eigenen Kennung des Geräts, zum Beispiel `devices.h61be-525f`. Enden zwei Geräte eines Modells
   auf dieselben vier Zeichen, bekommt das zweite seine ganze Kennung. In der Govee-App angelegte
   Gruppen erscheinen unter `groups.`.

## Umstieg von 2.x

Version 3.0.0 gibt jedem Gerät einmal eine neue Objekt-ID: aus `devices.h61be_525f` wird
`devices.h61be-525f`, mit Bindestrich wie bei den anderen Geräte-Adaptern dieses Entwicklers. Der
Umzug passiert beim ersten Start von selbst: Werte, Aufzeichnungs-Einstellungen, Räume, Funktionen
und Aliase ziehen mit, aufgezeichnete Verläufe laufen in ihrer bisherigen Reihe weiter. Skripte und
Visualisierungen mit den alten IDs müssen angepasst werden.

## Ein Problem melden

Im Reiter **Experte** des Adapters auf **Diagnose** drücken, Gerät wählen und den Knopf drücken:
Der Adapter erstellt einen Bericht, und der Browser legt ihn als Datei ab. Diese Datei an ein
GitHub-Issue anhängen — das Formular für Geräte-Unterstützung fragt genau nach dieser Datei.

Die Geräteliste zeigt alle Geräte, erreichbar oder nicht — ein Bericht wird gerade dann gebraucht,
wenn etwas klemmt. Der Datenpunkt `diag.lastExport` je Gerät hält fest, wann der letzte Bericht
erzeugt wurde.

Der Bericht ist **anonymisiert**: Adressen, E-Mail-Adressen und Gerätenamen werden durch
gleichbleibende Marken ersetzt, Gerätekennungen gekürzt, und Zugangsdaten tauchen gar nicht erst
auf. Derselbe echte Wert bekommt innerhalb einer Datei immer dieselbe Marke — der Bericht bleibt
also nachvollziehbar, ohne etwas über dein Zuhause preiszugeben. Die Datei erklärt das in ihrem
eigenen Kopf.

Ein Bericht ist das, was ein Gerät einpflegen oder einen Fehler finden lässt, ohne dass jemand
deine Hardware braucht. Reicht er dafür nicht, liegt das am Bericht und nicht an dir — bitte sag es
im Issue.

## Wo mehr steht

Das Wiki hat die Tiefe, auf Deutsch und Englisch:

- **Einrichtung** — die drei Stufen, die lokale Schnittstelle, Bestätigungscodes, was tun, wenn ein Kanal aus bleibt
- **Verhalten** — welcher Kanal was macht, wie Erreichbarkeit entschieden wird, was bei Cloud-Ausfall passiert
- **Datenpunkte** — jeder Datenpunkt, wer ihn schreibt und was du selbst schreiben darfst
- **Szenen und Snapshots** — Szenen, DIY-Szenen, Cloud-Snapshots und lokal gespeicherte Snapshots
- **Segmente** — Segmentsteuerung, der Erkennungs-Assistent, gekürzte Streifen und manuelle Segmentlisten
- **Gruppen** — wie sich Govee-App-Gruppen hier verhalten
- **Sensoren und Geräte** — Messwerte, Ereignisse und was die Cloud-Grenzen bedeuten
- **Geräte** — jedes unterstützte Modell, erzeugt aus dem Katalog des Adapters

→ <https://github.com/krobipd/ioBroker.govee-smart/wiki>

## Gerät nicht dabei?

Schick einen Diagnosebericht, dann kommt das Modell dazu. Genau dafür gibt es ihn — der Katalog
wächst aus Nutzer-Meldungen, und niemand muss Hardware verschicken.
