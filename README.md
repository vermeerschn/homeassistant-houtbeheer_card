# Houtbeheer-kaart

Lovelace-dashboardkaart voor de [Houtbeheer-integratie](https://github.com/vermeerschn/homeassistant-houtbeheer_integration): een overzicht van je houthokken met houtsoort, vochtpercentage, stookklaar-status en vuldatum, met handmatige metingen.

De kaart heeft de integratie nodig; die levert de entiteiten. Meerdere houtsoorten per hok vereisen een integratieversie met `houtbeheer.set_wood_types` (na 1.4.1); werk beide samen bij.

## Installatie

### Via HACS
1. Open HACS, kies de drie puntjes rechtsboven en dan **Aangepaste repositories**.
2. Voeg `https://github.com/vermeerschn/homeassistant-houtbeheer_card` toe met categorie **Dashboard** (vroeger *Lovelace*).
3. Download **Houtbeheer Card** en vernieuw je browser (`Ctrl + F5`).

### Handmatig
1. Download `houtbeheer-card.js` uit deze repo en plaats het in `/config/www/`.
2. Ga naar **Instellingen → Dashboards → drie puntjes → Bronnen** en voeg een bron toe met URL `/local/houtbeheer-card.js` en type **JavaScript-module**.
3. Vernieuw je browser (`Ctrl + F5`).

## Gebruik

```yaml
type: custom:houtbeheer-card
title: Houtbeheer
read_only: false
weergave: uitgebreid
kolommen: auto
tegelinhoud: [houtsoorten, vocht, status, actief]
```

| Optie | Standaard | Uitleg |
| --- | --- | --- |
| `title` | `Houtbeheer` | Titel bovenaan de kaart. |
| `read_only` | `false` | Toont alleen het overzicht en de opgeslagen gegevens; geen invoer, geen knoppen. |
| `weergave` | `uitgebreid` | `compact` toont per tegel alleen naam en vochtpercentage (handig voor een muurtablet). |
| `kolommen` | `auto` | Aantal tegels per rij (1 t/m 8). `auto` past zich aan de breedte aan. |
| `verloop` | `true` | Toont onder het gekozen hok een grafiek en lijst met de laatste 5 metingen. Vereist integratie 1.6.0. Met `false` verborgen. |
| `tegelinhoud` | zie uitleg | Lijst met wat op de tegel staat: `houtsoorten`, `vocht`, `status`, `laatste_meting`, `vuldatum`, `actief`. Standaard `[houtsoorten, vocht, status, actief]`, bij `compact` `[vocht, actief]`. |
| `hokken` | automatisch | Handmatige koppeling van entiteiten, zie hieronder. |
| `aantal_hokken` | – | Terugval voor oudere installaties zonder de attributen van de integratie. |

De kaart vindt de hokken zelf via de attributen `houtbeheer_hok`, `houtbeheer_id` en `houtbeheer_rol` die de integratie op elke entiteit zet. Entiteiten hernoemen is dus geen probleem.

### Handmatige koppeling

Alleen nodig als je de entiteiten niet via de integratie laat vinden:

```yaml
type: custom:houtbeheer-card
hokken:
  - nummer: 1
    houtsoort: sensor.houthok_1_houtsoorten
    invoer: number.houthok_1_nieuwe_vochtmeting
    opslaan: button.houthok_1_meting_opslaan
    vocht: sensor.houthok_1_opgeslagen_vochtgehalte
    datum: sensor.houthok_1_laatste_meting
    # optioneel:
    vuldatum: date.houthok_1_vuldatum
    actief: switch.houthok_1_actief_hok
    reset: button.houthok_1_reset_hok
    stookklaar: binary_sensor.houthok_1_stookklaar
```

Zonder `actief` en `reset` ontbreken de knoppen *Dit hok actief maken* en *Reset hok*. Zonder `stookklaar` rekent de kaart zelf met een vaste grens van 20% vocht.

## Gedrag

- **Verloop**: de grafiek zet de laatste 5 metingen op een echte tijdas, zodat je ook bij metingen die maanden uit elkaar liggen ziet of het hout vlot droogt. Een reset van het hok wist de geschiedenis.
- **Houtsoorten**: de knop *Houtsoorten* klapt een lijst met vinkjes open. Elk vinkje wordt meteen opgeslagen via de actie `houtbeheer.set_wood_types`. De tegel toont de gekozen soorten (bij meer dan twee: de eerste twee en `+N`).
- **Meting opslaan**: de kaart zet de ingevulde waarde in het invoerveld en drukt daarna op de knop *Meting opslaan*, zodat waarde en tijdstip samen worden vastgelegd. Een waarde buiten het bereik van het invoerveld wordt geweigerd.
- **Stookklaar**: de kaart volgt de binary sensor van de integratie, dus de drempel staat op één plek.
- **Verversen**: de kaart tekent alleen opnieuw als een entiteit van de kaart zelf verandert, niet bij elke wijziging elders in Home Assistant. Tijdens het typen blijft je invoer behouden.
