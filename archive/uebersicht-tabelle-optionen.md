# Übersichtstabelle verbessern — Optionen zur Auswahl (Entscheidungsvorlage)

> Status: **Optionen-Review, noch nicht beschlossen.** Wenn eine Option (oder Kombi)
> gewählt ist, wird daraus ein konkreter Umsetzungsplan (Dateien, Code, Versionsbump).

---

## Kontext

**Projekt:** StockScanner — selbst gehosteter Yahoo-Finance-Scanner. Backend `C:\Projects\StockScanner`
(Python, SQLite-Store `data/store.db`, Node-API `server/server.js`), Frontend
`C:\Projects\StockScanner-pwa` (installierbare PWA, GitHub Pages, deutschsprachig).
Aktueller PWA-Stand: **v1.4.2** (Holdings-Tracking, Mehrwährung, 200-Tage-Performance-Graph,
Recommender-Panel, Display-Fixes).

**Die „Übersicht“-Tabelle** wird in `public/src/viewer.js` in `buildCols()` aufgebaut
(dynamische Spalten je Report) und in `public/style.css` gestylt (`.table-scroll`, `table`,
`#tbl`, ~Zeilen 81–100). Aktuelle Spalten (~15):
*Ticker, Name, Δ1D, Rule, ML, Hindsight, Risk-Opt, Cons., Value (nur Portfolio), Price, RSI,
200DMA, ↕200, 50DMA, Δ21D, Mom14.*
Darstellung heute: horizontales Scrollen mit fixierter Ticker-Spalte (`position:sticky`).

**Das Kernproblem:** Auf dem Handy (Nutzung: **Android · Chrome**, ~360–390 px) sind 15 Spalten
zu viel — man sieht nie alles, Vergleichen über Spalten ist mühsam, „rechts gibt’s mehr“ ist
schlecht auffindbar. Verschärft dadurch, dass die Tabelle **zwei sehr verschiedene Fälle**
bedient:
- **Portfolio** — wenige Positionen, Fokus *Wert, Währung, Performance, Konsens*.
- **Screening** (Watchlist 39, Screenlist 746, S&P 500 503) — viele Zeilen, Fokus *Signale &
  Extremwerte schnell erkennen*.
Eine einzige Spaltenliste für beide ist zwangsläufig ein Kompromiss.

**Nutzerprofil (für die Gewichtung der Optionen):**
- Mobile-first, deutschsprachig, Schweiz (CHF-Heimwährung, SMI/.SW-Titel, Mehrwährung
  CHF/EUR/USD/GBP/BTC).
- Die Empfehlungen sind **Information/Entscheidungshilfe, kein Alpha** (siehe
  `PREDICTOR_SUMMARY.md`) → Tabelle dient **Überblick & Aufspüren von Auffälligkeiten**, nicht
  dem blinden Handeln nach einem Signal.
- Entwickler; Wert auf **einfache, wartbare, abhängigkeitsfreie** Lösungen (Charts sind
  handgezeichnetes Canvas, keine Libs). Bestehende Muster: `buildCols()` mit dynamischen
  Spalten, `localStorage`-Prefs (`pwa.stocks.currency`, `pwa.stocks.chartPrefs`).

---

## UX-Grundlagen (Forschung, kurz)

- **Nielsen Norman Group** (Datentabellen): Spalten minimieren, Wichtigstes links, Zahlen
  rechtsbündig, Kopf-/Schlüsselspalte fixieren; auf Mobile horizontales Scrollen möglichst
  vermeiden.
- **Responsive-Table-Muster** (Brad Frost / CSS-Tricks): „Priority Columns“ (unwichtige
  ausblenden), „Collapse-by-Row“ (Zeile → Karte), „Contained Scroll“.
- **Progressive Disclosure**: wenige Kernspalten, Details auf Antippen (weniger gleichzeitige
  Entscheidungen → Hick’s Law).
- **Tufte**: hohes Daten-Tinte-Verhältnis; **Sparklines** statt Zahlenkolonnen für Trends.
- **Farbcodierung/Heatmap** senkt die Leselast (Signal-Glyphen nutzen das schon).
- **Touch-Targets** ≥ 44 px (Zeilen-Tap „→ Chart“ existiert bereits).

---

## Die Optionen

### Option A — Status quo gezielt verbessern (Scroll optimieren)
Horizontales Scrollen bleibt: zweite **Sticky-Spalte** (Name oder Δ1D), dezenter „→ mehr“-
Schatten rechts als Scroll-Hinweis, **Kompaktmodus** (kleinere Paddings), Zahlen rechtsbündig +
Heatmap-Hintergründe.
- **Vorteile:** kleinster Eingriff, kein Verhaltenswechsel, reine CSS-/Mini-JS-Änderung.
- **Nachteile:** Grundproblem (zu viele Spalten) bleibt.
- **Aufwand:** niedrig. **Für:** nur den schlimmsten Schmerz lindern.

### Option B — Kartenansicht auf Mobile (Tabelle → Karten)
Jede Zeile wird auf schmalen Screens zur **Karte**: Ticker + Name gross oben, darunter 2 Zeilen
mit den wichtigsten Kennzahlen + Signal-Glyphen. Desktop/breit bleibt Tabelle.
- **Vorteile:** sehr mobilfreundlich, kein Seitwärtsscrollen, gut lesbar.
- **Nachteile:** weniger Dichte (746 Screening-Zeilen = viel Scrollen), Sortieren/Vergleichen
  schwieriger.
- **Aufwand:** mittel. **Für:** Portfolio top, grosse Listen weniger.

### Option C — Progressive Disclosure (wenige Spalten + Detail-Sheet)
Tabelle zeigt nur **3–4 Kernspalten** (z. B. Ticker, Konsens-Glyph, Value *oder* Δ1D). Tippen
öffnet ein **Bottom-Sheet** mit allen Kennzahlen + komplettem Recommender-Panel und Button
„→ Chart“.
- **Vorteile:** ruhige, scanbare Liste; Details on demand; baut auf vorhandenem „Zeile → Chart“.
- **Nachteile:** ein Extra-Tap; neues Sheet-UI nötig.
- **Aufwand:** mittel–hoch. **Für:** der saubere Mobile-Standard.

### Option D — Ansichts-Profile / Spalten-Presets  ⭐ (empfohlene Basis)
Umschalter mit **3 Presets**, passend zu den zwei Nutzungsfällen:
- **Holdings** (Portfolio): Ticker, Value, Δ1D, Δ21D, Konsens.
- **Signale**: Ticker, Rule, ML, Hindsight, Risk-Opt, Konsens.
- **Technik**: Ticker, Price, RSI, 50/200DMA, ↕200, Mom14.

Optional zusätzlich frei wählbare Spalten, in `localStorage` gespeichert (wie `currency`).
Defaults: Portfolio→*Holdings*, sonst→*Signale*.
- **Vorteile:** löst den Doppel-Nutzungs-Konflikt direkt; jede Ansicht passt aufs Handy ohne
  Scrollen; minimal-invasiv (Mechanik via `buildCols()` ist vorhanden); keine Dependencies.
- **Nachteile:** Nutzer wählt Preset (gute Defaults nötig).
- **Aufwand:** niedrig–mittel. **Für:** beste Passung zum konkreten Setup.

### Option E — Visuelle Verdichtung (Heatmap + Sparklines)
Spaltenzahl bleibt, aber Zahlen → **Farbe** (Heatmap je Spalte) + **Mini-Sparklines** (Trend aus
der ohnehin geladenen Series). Muster „lesen“ statt Ziffern.
- **Vorteile:** hohe Dichte, schnelles Scannen; passt zu Tufte/Canvas-Stil.
- **Nachteile:** löst Breite nicht allein (eher Ergänzung); exakte Werte erst per Tap/Tooltip.
- **Aufwand:** mittel. **Für:** Verstärker zu A/C/D, nicht allein.

---

## Empfehlung

**D als Basis + Bausteine aus C und A/E.**
1. **Ansichts-Profile (D)** mit Defaults (Portfolio→*Holdings*, sonst→*Signale*), in
   `localStorage`. Beseitigt den Kern-Konflikt, nutzt vorhandene `buildCols()`-Mechanik, wenig
   neuer Code, keine Dependencies.
2. **Detail-Sheet (C)**: Tap zeigt *alle* Felder + komplettes Panel, Button „→ Chart“. So darf
   die Tabelle schmal sein, ohne Information zu verlieren.
3. **Politur (A/E)**: rechtsbündige Zahlen + dezente Heatmap, Scroll-Schatten als Fallback.

Inkrementell, abhängigkeitsfrei, respektiert „Signale = Info, nicht Alpha“: Überblick zuerst,
Details auf Wunsch.

## Offene Fragen
- Welche **3–4 Spalten** im *Holdings*- und im *Signale*-Preset sind am wichtigsten?
- Detail per **Bottom-Sheet (C)** oder reicht der Sprung zum Chart wie bisher?
- Soll **Desktop/breit die volle Tabelle** behalten (nur Mobile vereinfachen) oder überall
  Presets?
- **Heatmap/Sparklines** jetzt oder später?

## Relevante Dateien (für die spätere Umsetzung)
- `C:\Projects\StockScanner-pwa\public\src\viewer.js` — `buildCols()` (dynamische Spalten),
  `renderHead()/renderBody()`, `select()` (Zeilen-Tap → Chart), `glyph()`/Signal-Logik.
- `C:\Projects\StockScanner-pwa\public\index.html` — `#page-overview`, `.overview-controls`
  (hier käme ein Preset-Umschalter, analog `#currency-sel`).
- `C:\Projects\StockScanner-pwa\public\style.css` — Tabellen-Styles (~81–100), ggf. Karten-/
  Sheet-/Heatmap-Styles.
- `localStorage`-Konvention: neuer Key z. B. `pwa.stocks.tablePreset`.
- Versionsbump bei Umsetzung: `config.js APP_VERSION` + `sw.js VERSION` (aktuell v1.4.2 → v1.4.3).


----------------------
Ich habe noch unabhängiges Feedback eingeholt:

Feedback 1:

===============================================================

 UX-RESEARCH REVIEW — MOBILE DATENTABELLEN IM STOCKSCANNER

===============================================================



1) PROBLEMVALIDIERUNG

---------------------

Mobile Tabellen mit >10 Spalten sind laut NN/g, Baymard und 

Mobile-HCI-Studien eines der schwierigsten UI-Elemente:

- Nutzer erkennen horizontales Scrollen schlecht (Low Discoverability).

- Vergleich über Spalten bricht auf kleinen Screens zusammen.

- Mixed-Use-Cases (Portfolio vs. Screening) verschärfen das Problem.

- "One-size-fits-all"-Tabellen funktionieren auf Mobile praktisch nie.



Deine Diagnose ist also 100% korrekt: Das Problem ist strukturell, 

nicht kosmetisch.



---------------------------------------------------------------

2) UX-BEWERTUNG DER OPTIONEN

---------------------------------------------------------------



A) STATUS QUO VERBESSERN

------------------------

UX-Research sagt: "Contained horizontal scroll" ist *akzeptabel*, 

aber nur, wenn:

- wenige Spalten,

- klarer Scroll-Hinweis,

- Sticky-Header/Sticky-Key-Column.



Bei 15 Spalten ist das laut Studien *nicht ausreichend*.  

→ Gut als "Painkiller", nicht als Lösung.



B) KARTENANSICHT (ROW → CARD)

-----------------------------

Mobile-HCI: Karten funktionieren hervorragend für:

- wenige Items,

- heterogene Informationen,

- Fokus auf einzelne Elemente.



Für große Listen (746 Zeilen) ist die Scroll-Länge aber ein 

nachgewiesenes Problem (Fitts + Scrolling Fatigue).  

→ Ideal für Portfolio, schlecht für Screening.



C) PROGRESSIVE DISCLOSURE (3–4 Spalten + Detail-Sheet)

-------------------------------------------------------

Das ist das *Standardmuster* für mobile Datenlisten:

- Wenige Kernattribute → schnelle Scannability.

- Details on demand → reduziert kognitive Last.

- Bottom-Sheet ist ein etabliertes Pattern (Android Material).



UX-Forschung bewertet dieses Muster als:

- schnell,

- effizient,

- am besten für heterogene Datensets.



→ Sehr stark. Einziger Nachteil: ein zusätzlicher Tap.



D) ANSICHTS-PROFILE / PRESETS

------------------------------

Das ist aus UX-Sicht ein "Task-Fit"-Ansatz:

- Nutzer haben unterschiedliche Ziele → unterschiedliche Spalten.

- Presets reduzieren Entscheidungslast (Hick’s Law).

- Gute Defaults sind entscheidend (Baymard: Defaults > 80% Nutzung).



Für deinen Doppel-Use-Case (Portfolio vs. Screening) ist das 

UX-seitig die *präziseste Lösung*.



→ Sehr hohe Wirksamkeit, sehr niedrige Komplexität.



E) VISUELLE VERDICHTUNG (HEATMAPS + SPARKLINES)

-----------------------------------------------

Heatmaps:

- Reduzieren Leselast,

- verbessern Mustererkennung,

- funktionieren besonders gut bei Screening-Tasks.



Sparklines:

- Tufte: "Data-intense, design-simple, word-sized graphics".

- Sehr effektiv für Trends, aber nicht als Ersatz für Spaltenbreite.



→ Starke Ergänzung, aber keine Lösung für das Breitenproblem.



---------------------------------------------------------------

3) UX-FAZIT (EVIDENZBASIERT)

---------------------------------------------------------------

Die Forschung ist eindeutig:



**Die beste Lösung ist eine Kombination aus:**

- **D (Presets)** = strukturelle Lösung für unterschiedliche Tasks.

- **C (Progressive Disclosure)** = mobile-optimierte Informationsarchitektur.

- **A/E (Politur)** = Wahrnehmungs- und Scan-Optimierung.



Diese Kombination entspricht exakt dem, was moderne mobile 

Finanz-Apps (Bloomberg, Trading212, Yahoo Finance, Revolut) tun.



---------------------------------------------------------------

4) UX-RISIKEN, DIE DU VERMEIDEST

---------------------------------------------------------------

- Kein Over-Engineering (keine Libs, keine komplexen Tabellen-Frameworks).

- Kein "Alles auf einmal zeigen" (klassischer Fehler bei Finanz-Tools).

- Kein "Mobile = verkleinerter Desktop" (NN/g: Anti-Pattern).



---------------------------------------------------------------

5) UX-EMPFEHLUNG (KONKRET)

---------------------------------------------------------------

1) **Presets sofort einführen**  

   → löst 80% des Problems mit minimalem Aufwand.



2) **Bottom-Sheet für Details**  

   → erlaubt radikale Spaltenreduktion ohne Informationsverlust.



3) **Heatmap + rechtsbündige Zahlen**  

   → verbessert Scanbarkeit massiv.



4) **Optional später: Sparklines**  

   → nice-to-have, nicht nötig für v1.



---------------------------------------------------------------

6) UX-FRAGEN, DIE NOCH ZU KLÄREN SIND

---------------------------------------------------------------

- Welche 3–4 Spalten pro Preset sind *task-kritisch*?

- Soll Desktop die volle Tabelle behalten oder auch Presets nutzen?

- Wie viel Detail gehört ins Bottom-Sheet (nur Zahlen oder auch 

  Recommender-Panel)?



===============================================================

 END OF REPORT

================================================================ 



---------------------------------------------------------------------------------------------------------------



Feedback 2:







UX-Review der Optionen für die StockScanner-Übersichtstabelle



== Executive Summary



Aus Sicht der UX-Forschung ist die vorgeschlagene Empfehlung *D + C + etwas A/E* sehr gut begründet.



Die stärkste Erkenntnis aus Forschung und Praxis lautet:



*Eine mobile Tabelle mit 15 Spalten ist kein Tabellenproblem, sondern ein Priorisierungsproblem.*



Fast alle modernen Design-Systeme (SAP Fiori, Material, Carbon, interne Enterprise-Dashboards) lösen breite Tabellen auf Smartphones über eine Kombination aus:



* Priorisierung der wichtigsten Spalten

* Progressive Disclosure

* Detailansichten pro Zeile

* Optionalen Presets oder Ansichten



Genau das entspricht Option D + C.



== Was die Forschung tatsächlich sagt



=== 1. Horizontales Scrollen ist erlaubt, aber selten optimal



Die Forschung ist deutlich differenzierter als oft behauptet.



Horizontales Scrollen ist bei Datentabellen nicht grundsätzlich falsch. Tabellen sind sogar eine explizite Ausnahme in den WCAG-Reflow-Regeln.



Aber:



* Nutzer erkennen horizontales Scrollen oft nicht.

* Der Vergleich von Werten wird schwieriger.

* Kontext geht verloren.

* Mehr mentale Belastung beim Merken von Spalten.



Mehrere Design-Systeme empfehlen daher:



* wichtigste Spalten sichtbar lassen

* erste Spalte fixieren

* Scrollbarkeit klar anzeigen

* unnötige Spalten entfernen



Das bedeutet:



Option A verbessert die Situation, löst aber nicht die Ursache. Sie ist eine gute Sofortmaßnahme, aber keine Endlösung.



=== 2. Mobile Tabellen funktionieren am besten mit Priorisierung



Ein bemerkenswerter Konsens zieht sich durch nahezu alle Quellen:



Auf Smartphones sollten nur die wichtigsten Informationen sichtbar bleiben.



SAP Fiori macht genau das:



* 1–2 Kernspalten bleiben sichtbar

* alle anderen Informationen wandern in einen "Pop-In"-Bereich unter der Zeile



Das ist praktisch dieselbe Idee wie Option C.



=== 3. Progressive Disclosure reduziert kognitive Last



NN/g beschreibt Progressive Disclosure als Muster zur Reduktion von Komplexität und Entscheidungslast.



Für StockScanner passt das besonders gut:



Der Nutzer möchte normalerweise nicht gleichzeitig



* RSI

* Mom14

* 50DMA

* 200DMA

* ML

* Rule

* Hindsight

* Risk-Opt



sehen.



Er möchte zuerst wissen:



"Welche Titel sind auffällig?"



Erst danach:



"Warum?"



Das spricht sehr stark für:



* kompakte Liste

* Tap auf Zeile

* Detail-Sheet



also Option C.



== Bewertung der einzelnen Optionen



=== Option A – Scroll optimieren



UX-Wertung: 6/10



Gut:



* sehr günstig

* praktisch kein Risiko

* Sticky-Spalte ist bewährtes Muster

* Scroll-Hinweis erhöht Discoverability



Schlecht:



* 15 Spalten bleiben 15 Spalten

* Vergleich bleibt schwierig

* löst den Portfolio-vs-Screener-Konflikt nicht



Empfehlung:



Als Sofortmaßnahme sinnvoll.

Nicht als Endzustand.



=== Option B – Kartenansicht



UX-Wertung: 7/10



Gut:



* hervorragend für Portfolio

* hervorragend für wenige Positionen

* mobil sehr lesbar



Schlecht:



* katastrophal für 746 Screening-Titel

* Vergleiche zwischen Zeilen werden schlechter

* enorme Scrollstrecken



Für eine Watchlist mit 20 Titeln wäre das fast ideal.



Für einen Scanner mit mehreren hundert Treffern eher nicht.



=== Option C – Progressive Disclosure



UX-Wertung: 9/10



Gut:



* entspricht modernen Mobile-Patterns

* reduziert kognitive Last

* skaliert von 10 bis 1000 Zeilen

* Details bleiben verfügbar



Schlecht:



* zusätzlicher Tap

* etwas mehr Implementierungsaufwand



Für einen Scanner ist das wahrscheinlich die sauberste Mobile-Lösung.



=== Option D – Presets



UX-Wertung: 9.5/10



Das ist aus meiner Sicht die stärkste Idee im gesamten Dokument.



Warum?



Weil das eigentliche Problem nicht Mobile ist.



Das eigentliche Problem ist:



Portfolio und Screening haben unterschiedliche Aufgaben.



Portfolio fragt:



* Was besitze ich?

* Wie entwickelt es sich?



Screening fragt:



* Was springt heute heraus?



Diese beiden Aufgaben benötigen unterschiedliche Informationsarchitekturen.



Option D löst genau dieses Problem.



Außerdem:



* technisch extrem günstig

* vorhandene buildCols()-Architektur passt perfekt

* Nutzer erhalten Kontrolle

* Forschung empfiehlt explizit auswählbare Attribute für Vergleiche



Das ist nahezu ein Lehrbuchbeispiel für gutes Dashboard-Design.



=== Option E – Heatmaps und Sparklines



UX-Wertung: 8/10



Sehr guter Verstärker.



Wichtig:



Heatmaps ersetzen keine Informationsarchitektur.



Sie helfen erst dann wirklich, wenn die Tabelle bereits sinnvoll reduziert wurde.



Empfohlene Reihenfolge:



1. D

2. C

3. E



nicht umgekehrt.



== Was ich konkret bauen würde



=== Phase 1 (v1.4.3)



Nur Option D.



Presets:



Holdings



* Ticker

* Value

* Δ1D

* Δ21D

* Konsens



Signale



* Ticker

* Rule

* ML

* Risk-Opt

* Konsens



Technik



* Ticker

* RSI

* 50DMA

* 200DMA

* Mom14



Gespeichert in:



---



## pwa.stocks.tablePreset



Sehr wenig Risiko.

Sehr hoher Nutzen.



=== Phase 2 (v1.4.4)



Bottom Sheet aus Option C.



Tap auf Zeile:



* vollständige Kennzahlen

* Recommender-Panel

* Chart-Button



Dadurch darf die Übersicht radikal vereinfacht werden.



=== Phase 3 (v1.4.5)



Visuelle Verdichtung:



* Heatmap für Δ1D, Δ21D, RSI

* Mini-Sparklines

* Scroll-Schatten als Fallback



== Antworten auf die offenen Fragen



=== Wichtigste Holdings-Spalten



1. Ticker

2. Value

3. Δ1D

4. Δ21D

5. Konsens



=== Wichtigste Signale-Spalten



1. Ticker

2. Rule

3. ML

4. Risk-Opt

5. Konsens



Hindsight würde ich ins Detail-Sheet verschieben.



=== Bottom Sheet oder direkt Chart?



Bottom Sheet.



Der Chart beantwortet:



"Wie sieht die Kursentwicklung aus?"



Das Sheet beantwortet:



"Warum steht die Aktie überhaupt in dieser Liste?"



Das sind unterschiedliche Fragen.



=== Presets nur Mobile oder überall?



Mobile: Presets verpflichtend.



Desktop: Presets + Option "Alle Spalten".



Power User werden die Vollansicht gelegentlich nutzen wollen.



=== Heatmaps jetzt oder später?



Später.



Sie verbessern die Wahrnehmung.



Sie lösen nicht die Kernprobleme.



== Fazit



Die Forschung spricht überraschend klar gegen eine reine Tabellenoptimierung (A) und gegen eine vollständige Kartenansicht (B).



Die stärkste Lösung für StockScanner ist:



*D (Presets) als Fundament, ergänzt durch C (Detail-Sheet).*



Genau diese Kombination adressiert den eigentlichen UX-Konflikt:



Nicht "15 Spalten auf Mobile", sondern



"zwei völlig unterschiedliche Jobs in derselben Tabelle".



Wenn ich die Optionen priorisieren müsste:



1. D – Presets

2. C – Detail-Sheet

3. E – Heatmap/Sparklines

4. A – Scroll-Politur

5. B – Kartenansicht



---------------------------------------------------------------------------------------------------------------


Mein weiterer Task:
Konsolidiere den Plan in der Art: lass uns eine überladene PWA Version v1.5.0 machen die im Infobereich ein Dropdown Darstellung hat.

Dort sind 4 Varianten zur Auswahl verfügbar:

1) Status Quo

2...4) 3 konsolidierte Darstellungen basierend auf dem konsolidiertem Feedback der 2 Reviewer.

Danach schreibe einen detailierten sequentiellen Plan zur Umsetzung des Plans durch eine Sonnet Instanz (von mir aufgerufen). Es soll keine Backstops geben, sondern in einem langen Prozess bis zur abschliessenden Implementierung der 4 Darstellungsvarianten durchlaufen. Dieser Implementierungs-Plan soll als C:\Projects\StockScanner-pwa\improve_gui.md von dir auf Englisch zur einfacheren Umsetzung durch Sonnet erstellt werden. Self sufficient step-by-step für Sonnet aber nicht unnötig ausschweifend.

